(function (root) {
  const streaming = typeof module !== 'undefined' && module.exports ? require('./streaming.js') : root.SidepadStreaming;
  const number = value => Number.isFinite(value) && value >= 0 ? value : null;
  const text = value => typeof value === 'string' ? value.slice(0, 160) : null;
  const boolean = value => typeof value === 'boolean' ? value : null;

  function sameStream(current, previous) {
    return previous && current.id === previous.id && current.ssrc === previous.ssrc &&
      current.codecId === previous.codecId && current.timestamp > previous.timestamp;
  }
  function delta(current, previous, key) {
    if (!sameStream(current, previous) || number(current[key]) === null || number(previous[key]) === null) return null;
    return number(current[key] - previous[key]);
  }
  function average(current, previous, total, count) {
    if (!sameStream(current, previous)) return null;
    return streaming.intervalAverageMs(current[total], current[count], previous[total], previous[count]);
  }
  function perSecond(current, previous, key) {
    const change = delta(current, previous, key);
    return change === null ? null : change * 1000 / (current.timestamp - previous.timestamp);
  }
  function senderMetrics(current, previous, report) {
    let pair;
    for (const stat of report.values()) {
      if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId);
    }
    const bytesPerSecond = perSecond(current, previous, 'bytesSent');
    return {
      encodeMs: average(current, previous, 'totalEncodeTime', 'framesEncoded'),
      // Packet-weighted local queue delay: not a per-frame or network transit measurement.
      sendQueueMs: average(current, previous, 'totalPacketSendDelay', 'packetsSent'),
      encodedFps: perSecond(current, previous, 'framesEncoded'),
      bitrateMbps: bytesPerSecond === null ? null : bytesPerSecond * 8 / 1000000,
      rttMs: number(pair?.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000,
      width: number(current.frameWidth), height: number(current.frameHeight),
      codec: text(report.get(current.codecId)?.mimeType), codecParameters: text(report.get(current.codecId)?.sdpFmtpLine),
      encoder: text(current.encoderImplementation),
      powerEfficient: boolean(current.powerEfficientEncoder),
      limitation: ['none', 'cpu', 'bandwidth', 'other'].includes(current.qualityLimitationReason) ? current.qualityLimitationReason : null
    };
  }
  function receiverMetrics(current, previous, tuning, lowLatency) {
    return {
      bufferMs: average(current, previous, 'jitterBufferDelay', 'jitterBufferEmittedCount'),
      decodeMs: average(current, previous, 'totalDecodeTime', 'framesDecoded'),
      // Includes buffer/reassembly/decode; never sum this with those components.
      receiveProcessMs: average(current, previous, 'totalProcessingDelay', 'framesDecoded'),
      targetBufferMs: average(current, previous, 'jitterBufferTargetDelay', 'jitterBufferEmittedCount'),
      minimumBufferMs: average(current, previous, 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'),
      decodedFps: perSecond(current, previous, 'framesDecoded'),
      droppedFrames: delta(current, previous, 'framesDropped'),
      lostPackets: delta(current, previous, 'packetsLost'),
      freezes: delta(current, previous, 'freezeCount'),
      width: number(current.frameWidth), height: number(current.frameHeight),
      decoder: text(current.decoderImplementation), powerEfficient: boolean(current.powerEfficientDecoder),
      bufferControl: !lowLatency ? 'automatic' : tuning?.applied ? 'minimum' : tuning?.supported ? 'failed' : 'unsupported'
    };
  }
  const numericReceiverFields = ['bufferMs', 'decodeMs', 'receiveProcessMs', 'targetBufferMs', 'minimumBufferMs', 'decodedFps', 'droppedFrames', 'lostPackets', 'freezes', 'width', 'height'];
  function validReceiverMetrics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = [...numericReceiverFields, 'decoder', 'powerEfficient', 'bufferControl'];
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return false;
    return numericReceiverFields.every(key => value[key] === null || (number(value[key]) !== null && value[key] <= 1000000000)) &&
      (value.decoder === null || (typeof value.decoder === 'string' && value.decoder.length <= 160)) &&
      (value.powerEfficient === null || typeof value.powerEfficient === 'boolean') &&
      ['automatic', 'minimum', 'failed', 'unsupported'].includes(value.bufferControl);
  }
  function freshReceiver(sample, now) {
    return sample && now >= sample.receivedAt && now - sample.receivedAt <= 6500 ? sample.metrics : null;
  }
  function acceptReceiver(previous, signal, activeSession, now) {
    if (!activeSession || signal.sessionId !== activeSession || !Number.isSafeInteger(signal.sequence) || signal.sequence < 0 ||
        (previous && signal.sequence <= previous.sequence) || !validReceiverMetrics(signal.metrics)) return previous;
    return { sequence: signal.sequence, receivedAt: now, metrics: signal.metrics };
  }
  function efficiencyLabel(value) {
    // The power-efficient flag is a browser hint, not proof of a specific GPU encoder.
    return value === true ? '고효율 보고' : value === false ? '고효율 아님' : '확인 불가';
  }
  function diagnosis(sender, receiver, fps) {
    if (!sender || sender.encodeMs === null) return '움직이는 화면을 보낸 뒤 최근 구간의 통계를 확인해 주세요.';
    const budget = 1000 / fps;
    if (sender.limitation === 'cpu' || sender.encodeMs > budget) return 'PC 처리 여유를 확인하세요. 인코더와 CPU 사용량을 비교하고, 필요하면 해상도를 유지한 채 30 fps로 시험하세요.';
    if (sender.limitation === 'bandwidth' || sender.sendQueueMs > budget) return '전송 대기 또는 대역폭 제한이 관측됩니다. 공유기 연결과 실제 전송률을 확인하세요.';
    if (!receiver) return '기기 진단을 기다리고 있습니다. 오래된 수신 수치는 표시하지 않습니다.';
    if (receiver.decodeMs > budget) return '수신 기기의 디코딩 시간이 프레임 간격보다 깁니다. 기기의 부하와 디코더를 확인하세요.';
    if (receiver.bufferMs > budget * 2) return '수신 버퍼 대기가 큽니다. 최소 버퍼 적용 여부와 Wi-Fi 변동을 확인하세요.';
    return '측정된 구간에서 큰 지연은 관측되지 않습니다. 캡처 대기와 실제 화면 표시는 별도 측정이 필요합니다.';
  }
  const api = { senderMetrics, receiverMetrics, validReceiverMetrics, freshReceiver, acceptReceiver, efficiencyLabel, diagnosis };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SidepadDiagnostics = Object.freeze(api);
})(globalThis);
