const $ = id => document.getElementById(id);
const api = window.sidepad;
const { createStreamSettings, applySenderSettings } = window.SidepadStreaming;
const diagnostics = window.SidepadDiagnostics;
let config, stream, peer, peerId, negotiation, candidates = [], signalQueue = Promise.resolve();
let starting = false, offering = false, offerPending = false, statsTimer, previousStats;
let activeSettings, senderTuning;
let senderDiagnostics = null, senderUpdatedAt = 0, receiverDiagnostics = null, resourceStats = null;

function diagnosticReport() {
  const now = performance.now();
  const senderFresh = now - senderUpdatedAt <= 6500;
  return {
    version: 1, recordedAt: new Date().toISOString(), settings: activeSettings || null,
    sender: senderFresh ? senderDiagnostics : null,
    receiver: diagnostics.freshReceiver(receiverDiagnostics, now), resources: senderFresh ? resourceStats : null,
    notes: ['Recent interval averages; sendQueueMs is per packet, encode/buffer/decode are per frame.',
      'receiveProcessMs includes buffer/reassembly/decode. Do not sum overlapping metrics.',
      'Capture-to-display latency and GPU utilization are not measured. Encoder efficiency is a browser hint, not proof of NVENC.',
      'CPU percentage covers processes in this Sidepad instance, normalized to all logical CPU cores.']
  };
}
function renderDiagnostics() {
  const { sender, receiver, resources } = diagnosticReport();
  const ms = value => Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—';
  $('diag-encode').textContent = ms(sender?.encodeMs);
  $('diag-send').textContent = ms(sender?.sendQueueMs);
  $('diag-buffer').textContent = ms(receiver?.bufferMs);
  $('diag-decode').textContent = ms(receiver?.decodeMs);
  $('diag-receive').textContent = ms(receiver?.receiveProcessMs);
  $('diag-cpu').textContent = Number.isFinite(resources?.cpuPercent) ? `${resources.cpuPercent.toFixed(1)}%` : '—';
  $('diag-encoder').textContent = `인코더: ${sender?.codec || '—'} / ${sender?.encoder || '확인 불가'} · ${diagnostics.efficiencyLabel(sender?.powerEfficient)}`;
  const bufferLabels = { minimum: '최소 버퍼 요청 적용', automatic: '자동 버퍼', unsupported: '버퍼 제어 미지원', failed: '버퍼 제어 적용 실패' };
  $('diag-decoder').textContent = receiver
    ? `디코더: ${receiver.decoder || '확인 불가'} · ${bufferLabels[receiver.bufferControl]} · 제외 ${receiver.droppedFrames ?? '—'} 프레임`
    : '기기 진단 대기 · 마지막 수신으로부터 6.5초가 지나면 수치를 숨깁니다.';
  const reasons = { none: '제한 보고 없음', cpu: 'CPU', bandwidth: '대역폭', other: '기타' };
  $('diag-limits').textContent = `브라우저 제한 사유: ${reasons[sender?.limitation] || '확인 불가'} · 영상 인코딩 가속 지원: ${resources?.videoEncodeFeature || '확인 불가'}`;
  $('diag-hint').textContent = diagnostics.diagnosis(sender, receiver, activeSettings?.fps || 60);
}

function message(text) { $('message').textContent = text; $('message').hidden = !text; }
function status(text) { $('status').textContent = text; }
function syncControls() {
  const busy = starting || Boolean(stream);
  $('low-latency').disabled = busy;
  $('display').disabled = busy;
  $('quality').disabled = busy;
  $('fps').disabled = busy;
  $('start').disabled = busy || !$('display').value;
}
function changeMode() {
  const low = $('low-latency').checked;
  $('mode-hint').textContent = low
    ? '선택한 해상도와 프레임을 사용하며, 수신 버퍼 대기를 줄이고 PC 미리보기를 생략합니다. 끊기면 30 fps로 비교해 보세요.'
    : '표준 모드 · PC 미리보기와 자동 수신 버퍼를 사용합니다. 선택한 해상도와 프레임은 그대로 유지됩니다.';
  syncControls();
}
function showDisplays(list) {
  const previous = $('display').value;
  $('display').replaceChildren();
  const available = list.filter(item => !item.primary && item.available);
  for (const item of available) {
    $('display').add(new Option(`${item.label} · ${item.width} × ${item.height}`, item.id));
  }
  if (!available.length) $('display').add(new Option('확장된 보조 디스플레이가 없습니다', ''));
  if (available.some(item => item.id === previous)) $('display').value = previous;
  else {
    const virtual = available.find(item => item.label === 'VDD by MTT');
    if (virtual) $('display').value = virtual.id;
  }
  $('setup').hidden = Boolean(available.length);
  syncControls();
  if (!stream) $('preview-label').textContent = available.length ? '선택한 보조 화면을 기기로 보냅니다' : '확장 모니터를 연결해 주세요';
}

function closePeer() {
  negotiation = null;
  candidates = [];
  if (peer) { peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.close(); peer = null; }
  clearInterval(statsTimer);
  previousStats = null;
  senderDiagnostics = null;
  receiverDiagnostics = null;
  resourceStats = null;
  renderDiagnostics();
  $('framerate').textContent = '— fps';
  $('bitrate').textContent = '— Mbps';
  $('roundtrip').textContent = '왕복 — ms';
  senderTuning = null;
}

async function offer() {
  if (!stream || !peerId || !activeSettings) return;
  if (offering) { offerPending = true; return; }
  offering = true;
  closePeer();
  const target = peerId;
  const settings = activeSettings;
  const sessionId = crypto.randomUUID();
  negotiation = sessionId;
  const pc = new RTCPeerConnection({ iceServers: [] });
  peer = pc;
  const signal = value => api.send({ peerId: target, signal: { ...value, sessionId } });
  pc.onicecandidate = event => { if (event.candidate && peer === pc) signal({ type: 'candidate', candidate: event.candidate.toJSON() }).catch(error => message(error.message)); };
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return;
    status(pc.connectionState === 'connected' ? '전송 중' : '연결 중');
    if (pc.connectionState === 'failed') { status('연결 확인 필요'); message('영상 연결에 실패했습니다. 같은 네트워크와 Windows 방화벽을 확인한 뒤 기기에서 다시 연결해 주세요.'); }
    $('viewer-state').textContent = pc.connectionState === 'connected' ? '기기에 화면 전송 중' : '기기 영상 연결 중';
  };
  try {
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const transceiver = pc.getTransceivers()[0];
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (codecs && transceiver?.setCodecPreferences) transceiver.setCodecPreferences([...codecs.filter(c => c.mimeType === 'video/H264'), ...codecs.filter(c => c.mimeType !== 'video/H264')]);
    await pc.setLocalDescription(await pc.createOffer());
    if (peer !== pc || peerId !== target) return;
    const sender = pc.getSenders().find(item => item.track?.kind === 'video');
    const tuning = await applySenderSettings(sender, settings);
    if (peer !== pc || peerId !== target) return;
    senderTuning = tuning;
    if (!tuning.applied) message('브라우저가 전송률 설정을 적용하지 못했습니다. 선택한 캡처 해상도와 프레임으로 전송합니다.');
    await signal({ type: 'offer', sdp: pc.localDescription.sdp, lowLatency: settings.lowLatency });
    if (peer !== pc) return;
    let statsBusy = false;
    statsTimer = setInterval(async () => {
      renderDiagnostics();
      if (statsBusy) return;
      statsBusy = true;
      try {
        const [stats, resources] = await Promise.all([pc.getStats(), api.performance().catch(() => null)]);
        if (peer !== pc) return;
        resourceStats = resources;
        for (const stat of stats.values()) {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue;
          senderDiagnostics = diagnostics.senderMetrics(stat, previousStats, stats);
          senderUpdatedAt = performance.now();
          if (stat.frameWidth > 0 && stat.frameHeight > 0) $('resolution').textContent = `${stat.frameWidth} × ${stat.frameHeight}`;
          $('framerate').textContent = `${senderDiagnostics.encodedFps === null ? '—' : Math.round(senderDiagnostics.encodedFps)} fps`;
          $('bitrate').textContent = `${senderDiagnostics.bitrateMbps === null ? '—' : senderDiagnostics.bitrateMbps.toFixed(1)} Mbps`;
          $('roundtrip').textContent = `왕복 ${senderDiagnostics.rttMs === null ? '—' : Math.round(senderDiagnostics.rttMs)} ms`;
          previousStats = stat;
        }
        renderDiagnostics();
      } catch { /* Connection may be closed during polling. */ }
      finally { statsBusy = false; }
    }, 2000);
  } catch (error) {
    if (peer === pc) { closePeer(); message(`영상 연결을 시작할 수 없습니다: ${error.message}`); }
  } finally {
    offering = false;
    if (offerPending) { offerPending = false; queueMicrotask(offer); }
  }
}

async function begin() {
  if (starting || stream) return;
  starting = true;
  activeSettings = createStreamSettings({ lowLatency: $('low-latency').checked, quality: $('quality').value, fps: $('fps').value });
  syncControls();
  message('');
  try {
    await api.select($('display').value);
    const settings = activeSettings;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: settings.width }, height: { max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } }, audio: false
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = settings.contentHint;
    track.addEventListener('ended', () => stop());
    $('preview').srcObject = settings.lowLatency ? null : stream;
    $('preview').hidden = settings.lowLatency;
    $('illustration').hidden = !settings.lowLatency;
    $('preview-label').textContent = settings.lowLatency ? '저지연 모드 · PC 미리보기를 생략합니다' : '보조 화면 미리보기';
    const capture = track.getSettings();
    $('resolution').textContent = `${capture.width} × ${capture.height} · 캡처`;
    await api.active(true);
    syncControls();
    $('start').hidden = true;
    $('stop').hidden = false;
    status(peerId ? '연결 중' : '기기 대기');
    await offer();
  } catch (error) { await stop(); message(`화면 전송을 시작하지 못했습니다: ${error.message}`); }
  finally { starting = false; syncControls(); }
}

async function stop() {
  closePeer();
  const old = stream;
  stream = null;
  activeSettings = null;
  old?.getTracks().forEach(track => track.stop());
  $('preview').srcObject = null;
  $('preview').hidden = true;
  $('illustration').hidden = false;
  $('preview-label').textContent = '선택한 보조 화면을 기기로 보냅니다';
  $('resolution').textContent = '— 해상도';
  syncControls();
  $('start').hidden = false;
  $('stop').hidden = true;
  status('준비됨');
  await api.active(false);
}

api.onViewer(data => {
  closePeer();
  peerId = data.connected ? data.peerId : null;
  $('dot').classList.toggle('online', data.connected);
  $('viewer-state').textContent = data.connected ? '기기 연결됨' : '기기 접속 대기';
  $('viewer-hint').textContent = data.connected ? '화면 전송을 시작하면 기기에 표시됩니다.' : 'PC와 같은 공유기를 사용해 주세요.';
  $('disconnect').hidden = !data.connected;
  if (data.connected) offer();
  else status(stream ? '기기 대기' : '준비됨');
});
api.onSignal(({ peerId: from, signal }) => {
  const pc = peer;
  signalQueue = signalQueue.then(async () => {
    if (!pc || pc !== peer || from !== peerId || signal.sessionId !== negotiation) return;
    if (signal.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
    } else if (signal.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else candidates.push(signal.candidate);
    } else if (signal.type === 'diagnostics') {
      receiverDiagnostics = diagnostics.acceptReceiver(receiverDiagnostics, signal, negotiation, performance.now());
      renderDiagnostics();
    }
  }).catch(error => { if (pc === peer) message(`연결 협상 오류: ${error.message}`); });
});
api.onRetry(({ peerId: from }) => { if (from === peerId) offer(); });
api.onDisplays(showDisplays);
api.onRemoved(async () => { await stop(); message('선택한 디스플레이의 연결이 해제되었습니다. 다른 보조 화면을 선택해 주세요.'); });
api.onError(message);
api.onDriverResult(async result => {
  $('install').disabled = false;
  $('install').textContent = '드라이버 설치';
  message(result.message);
  showDisplays(await api.list());
});
$('start').onclick = begin;
$('low-latency').onchange = changeMode;
changeMode();
$('stop').onclick = () => stop().catch(error => message(error.message));
$('refresh').onclick = async () => { try { showDisplays(await api.list()); } catch (error) { message(error.message); } };
$('settings').onclick = () => api.settings();
$('driver-page').onclick = () => api.driverPage();
$('add-virtual').onclick = () => { $('setup').hidden = !$('setup').hidden; };
$('install').onclick = async () => {
  $('install').disabled = true;
  $('install').textContent = '설치 진행 중…';
  try { await api.installDriver(); } catch (error) { $('install').disabled = false; $('install').textContent = '드라이버 설치'; message(error.message); }
};
$('disconnect').onclick = () => api.disconnect();
$('copy').onclick = async () => { await api.copy($('network').value); message('연결 링크를 복사했습니다. 연결할 기기의 브라우저에서 열어 주세요.'); };
$('copy-diagnostics').onclick = async () => {
  try { await api.copyDiagnostics(JSON.stringify(diagnosticReport(), null, 2)); message('진단 결과를 복사했습니다. 연결 토큰이나 화면 영상은 포함하지 않습니다.'); }
  catch (error) { message(error.message); }
};
function showNetwork() {
  const link = config.links.find(item => item.ip === $('network').value);
  if (link) $('qr').src = link.qr;
  $('qr').hidden = !link;
  $('no-network').hidden = Boolean(link);
  $('copy').disabled = !link;
}
$('network').onchange = showNetwork;
api.config().then(result => {
  config = result;
  if (result.preview) {
    document.title = 'Sidepad · 저지연 미리보기 (3212)';
    document.querySelector('.version').textContent = 'PREVIEW / 3212';
  }
  peerId = result.peerId;
  showDisplays(result.displays);
  for (const link of result.links) $('network').add(new Option(`${link.ip}:${result.port}`, link.ip));
  showNetwork();
  status('준비됨');
}).catch(error => { status('시작 실패'); message(error.message); });
