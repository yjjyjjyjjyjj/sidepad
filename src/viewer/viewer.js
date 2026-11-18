const $ = id => document.getElementById(id);
const { applyReceiverLatency } = window.SidepadStreaming;
const { receiverMetrics } = window.SidepadDiagnostics;
const codecTools = window.SidepadCodecs;
const token = location.hash.slice(1);
// Keep the pairing secret out of request URLs, referrers, and server logs.
let socket, peer, sessionId, signalQueue = Promise.resolve(), candidateQueue = [];
let reconnectTimer, statsTimer, wakeLock, joined = false, retryCount = 0, terminal = false;
let previousInbound, receiverTuning = null;
let latestDiagnostics = null;

function welcome(title, description) {
  $('welcome').hidden = false;
  $('title').textContent = title;
  $('description').textContent = description;
}
function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function closePeer() {
  clearInterval(statsTimer);
  if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.close(); peer = null; }
  sessionId = null;
  $('screen').srcObject = null;
  $('stats').textContent = '';
  $('mode-status').hidden = true;
  $('buffer-stats').hidden = true;
  previousInbound = null;
  receiverTuning = null;
  latestDiagnostics = null;
  $('play').hidden = true;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
async function keepAwake() {
  if (!navigator.wakeLock || document.hidden || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* Optional on Safari / HTTP. */ }
}

async function receiveOffer(signal) {
  closePeer();
  sessionId = signal.sessionId;
  const id = sessionId;
  const pc = new RTCPeerConnection({ iceServers: [] });
  peer = pc;
  const lowLatency = signal.lowLatency === true;
  $('mode-status').textContent = lowLatency ? '저지연' : '표준';
  $('mode-status').hidden = false;
  pc.onicecandidate = event => { if (peer === pc && event.candidate) send({ type: 'candidate', sessionId: id, candidate: event.candidate.toJSON() }); };
  pc.ontrack = event => {
    if (peer !== pc) return;
    receiverTuning = applyReceiverLatency(event.receiver, lowLatency);
    if (lowLatency && !receiverTuning.applied) {
      $('mode-status').textContent = '저지연 · 버퍼 자동';
      $('mode-status').title = '이 브라우저는 수신 버퍼 조절을 지원하지 않아 자동 버퍼를 사용합니다. 송신 측 저지연 설정은 적용됩니다.';
    } else {
      $('mode-status').title = lowLatency ? '수신 버퍼 대기를 최소화하도록 요청했습니다. 실제 대기 시간은 브라우저와 네트워크 상태에 따라 달라집니다.' : '브라우저 기본 버퍼 설정을 사용합니다.';
    }
    $('screen').srcObject = event.streams[0] || new MediaStream([event.track]);
    $('screen').play().catch(() => { $('play').hidden = false; });
  };
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return;
    if (pc.connectionState === 'connected') {
      $('status').textContent = '연결됨';
      retryCount = 0;
      keepAwake();
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      $('status').textContent = '연결 확인 필요';
      welcome('연결이 잠시 끊겼어요.', 'Wi-Fi와 PC 앱을 확인한 뒤 다시 연결해 주세요.');
      $('retry').hidden = false;
    }
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
  const receiverCodecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
  let codecPreferenceApplied = false;
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track.kind === 'video') codecPreferenceApplied = codecTools.applyCodecPreferences(transceiver, receiverCodecs, signal.encoderPreference || 'compatibility');
  }
  for (const item of candidateQueue.splice(0)) if (item.sessionId === id) await pc.addIceCandidate(item.candidate);
  await pc.setLocalDescription(await pc.createAnswer());
  if (peer !== pc) return;
  send({ type: 'answer', sessionId: id, sdp: pc.localDescription.sdp,
    codecCapabilities: codecTools.summarizeCodecs(receiverCodecs), codecPreferenceApplied });
  let statsBusy = false, sequence = 0;
  statsTimer = setInterval(async () => {
    if (statsBusy) return;
    statsBusy = true;
    try {
      const report = await pc.getStats();
      if (peer !== pc) return;
      for (const stat of report.values()) {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') continue;
        $('stats').textContent = `${stat.frameWidth || '—'} × ${stat.frameHeight || '—'} · ${Math.round(stat.framesPerSecond || 0)} fps`;
        const metrics = receiverMetrics(stat, previousInbound, receiverTuning, lowLatency);
        latestDiagnostics = metrics;
        previousInbound = stat;
        $('buffer-stats').hidden = false;
        $('buffer-stats').textContent = `버퍼 ${metrics.bufferMs === null ? '—' : metrics.bufferMs.toFixed(1)} ms · 디코딩 ${metrics.decodeMs === null ? '—' : metrics.decodeMs.toFixed(1)} ms`;
        // Diagnostics are disposable; don't let a blocked signaling socket accumulate samples.
        if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 8192) {
          send({ type: 'diagnostics', sessionId: id, sequence: sequence++, metrics });
        }
      }
    } catch { /* Closed while polling. */ }
    finally { statsBusy = false; }
  }, 2000);
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!/^[a-f0-9]{48}$/.test(token)) {
    welcome('연결 링크가 필요해요.', 'Windows 앱에 표시된 QR 코드를 다시 스캔해 주세요.');
    $('join').hidden = true;
    return;
  }
  if (!window.RTCPeerConnection) {
    welcome('이 브라우저에서는 연결할 수 없어요.', 'WebRTC를 지원하는 최신 Safari, Chrome 또는 Edge에서 연결 링크를 열어 주세요.');
    return;
  }
  terminal = false;
  joined = true;
  $('join').hidden = true;
  $('retry').hidden = true;
  $('detail').textContent = '';
  $('status').textContent = '연결 중';
  welcome('PC에 연결하고 있어요.', '두 기기가 같은 네트워크에 있는지 확인해 주세요.');
  const previousSocket = socket;
  socket = null;
  if (previousSocket) { previousSocket.onclose = null; previousSocket.close(); }
  closePeer();
  candidateQueue = [];
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token }));
  ws.onmessage = event => {
    signalQueue = signalQueue.then(async () => {
      if (socket !== ws) return;
      const signal = JSON.parse(event.data);
      if (signal.type === 'welcome') {
        $('status').textContent = signal.active ? '영상 연결 중' : 'PC 연결됨';
        welcome('두 번째 화면, 준비됐어요.', 'Windows 앱에서 화면 전송을 시작해 주세요.');
      } else if (signal.type === 'offer') {
        $('status').textContent = '영상 연결 중';
        $('retry').hidden = true;
        await receiveOffer(signal);
      } else if (signal.type === 'candidate') {
        if (peer?.remoteDescription && signal.sessionId === sessionId) await peer.addIceCandidate(signal.candidate);
        else if (candidateQueue.length < 100) candidateQueue.push(signal);
      } else if (signal.type === 'stopped') {
        closePeer();
        candidateQueue = [];
        $('status').textContent = '전송 대기';
        welcome('화면 전송이 멈췄어요.', 'Windows 앱에서 다시 시작할 수 있습니다.');
      }
    }).catch(error => {
      welcome('영상을 연결하지 못했어요.', 'PC 방화벽과 Wi-Fi 연결을 확인해 주세요.');
      $('detail').textContent = error.message;
      $('retry').hidden = false;
    });
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    closePeer();
    $('status').textContent = '연결 끊김';
    terminal = [4000, 4002, 4003, 4009].includes(event.code);
    const reasons = { 4000: 'PC에서 연결을 종료했습니다.', 4003: 'PC 앱의 새 QR 코드를 스캔해 주세요.', 4009: '다른 기기가 연결되어 있습니다.', 4002: '연결 정보가 올바르지 않습니다. 다시 연결해 주세요.' };
    welcome('연결이 종료되었어요.', reasons[event.code] || 'PC 앱을 켜고 같은 Wi-Fi에 연결해 주세요. 자동으로 재연결합니다.');
    $('retry').hidden = event.code === 4003;
    if (!terminal && !document.hidden) reconnectTimer = setTimeout(connect, Math.min(8000, 1000 * 2 ** retryCount++));
  };
  ws.onerror = () => { $('detail').textContent = 'PC 앱, 네트워크 주소, 방화벽 설정을 확인해 주세요.'; };
}

$('screen').onplaying = () => {
  $('welcome').hidden = true;
  $('play').hidden = true;
  $('status').textContent = '화면 수신 중';
  keepAwake();
};
$('join').onclick = connect;
$('retry').onclick = () => {
  if (socket?.readyState === WebSocket.OPEN) {
    closePeer();
    candidateQueue = [];
    send({ type: 'retry' });
    $('retry').hidden = true;
    welcome('다시 연결하고 있어요.', 'PC 화면을 기다리고 있습니다.');
  } else connect();
};
$('play').onclick = () => $('screen').play().catch(() => {});
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if ($('screen').webkitEnterFullscreen && $('screen').srcObject) $('screen').webkitEnterFullscreen();
  } catch { /* Fullscreen support varies by iPadOS. */ }
};
$('hide-tools').onclick = () => { $('toolbar').hidden = true; $('show-tools').hidden = false; };
$('show-tools').onclick = () => { $('toolbar').hidden = false; $('show-tools').hidden = true; };
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !joined || terminal) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  else if (!peer || ['failed', 'disconnected'].includes(peer.connectionState)) send({ type: 'retry' });
  else { $('screen').play().catch(() => { $('play').hidden = false; }); keepAwake(); }
});
window.addEventListener('pagehide', () => { clearTimeout(reconnectTimer); closePeer(); if (socket) { socket.onclose = null; socket.close(); } });
window.addEventListener('pageshow', event => { if (event.persisted && joined && !terminal) connect(); });
if (!/^[a-f0-9]{48}$/.test(token)) { welcome('연결 링크가 필요해요.', 'Windows 앱에 표시된 QR 코드를 스캔해 주세요.'); $('join').hidden = true; }
