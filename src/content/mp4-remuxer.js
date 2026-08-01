(() => {
  if (globalThis.MediaScoutMp4Remuxer) return;

  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const VIDEO_TIMESCALE = 90000;

  /**
   * Lightweight MPEG-TS (H.264 + AAC) to MP4 remuxer.
   * This does not decrypt, decode, transcode, or bypass browser/network rules.
   * It only repackages already-fetched, non-encrypted MPEG-TS samples into MP4 boxes.
   */
  async function remuxToMp4(segmentBuffers, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const work = remuxWorkTuning(options.workMode);
    onProgress({ phase: 'remuxing', percent: 0, detail: 'Parsing MPEG-TS packets' });
    const tracks = await parseTransportStream(segmentBuffers, (progress) => {
      onProgress({ phase: 'remuxing', percent: Math.min(45, Math.round(progress * 45)), detail: 'Parsing MPEG-TS packets' });
    }, work);
    await wait(work.phaseYieldMs);

    if (!tracks.video.samples.length) throw unsupported('mp4-remux-no-video', 'No H.264 video samples were found in the MPEG-TS segments.');
    if (!tracks.video.sps || !tracks.video.pps) throw unsupported('mp4-remux-missing-avc-config', 'The H.264 SPS/PPS metadata needed for MP4 remuxing was not found.');
    if (tracks.video.unsupportedCodec) throw unsupported('mp4-remux-unsupported-video-codec', `Unsupported video codec in TS: ${tracks.video.unsupportedCodec}.`);
    if (tracks.audio.unsupportedCodec) throw unsupported('mp4-remux-unsupported-audio-codec', `Unsupported audio codec in TS: ${tracks.audio.unsupportedCodec}.`);

    onProgress({ phase: 'remuxing', percent: 55, detail: 'Building MP4 sample tables' });
    await wait(work.phaseYieldMs);
    normalizeVideoSamples(tracks.video.samples);
    normalizeAudioSamples(tracks.audio.samples, tracks.audio.sampleRate || 48000);
    const syncInfo = alignTracksToFirstKeyframe(tracks);
    normalizeVideoSamples(tracks.video.samples);
    normalizeAudioSamples(tracks.audio.samples, tracks.audio.sampleRate || 48000);

    const expectedDuration = Number(options.expectedDurationSeconds) || 0;
    await wait(work.phaseYieldMs);
    const quality = assessRemuxQuality(tracks, expectedDuration);
    if (!quality.ok) throw unsupported(quality.code, quality.message);
    const fps = quality.estimatedVideoFps;

    const dimensions = parseSpsDimensions(tracks.video.sps) || parseResolutionHint(options.resolution) || { width: 1920, height: 1080 };
    tracks.video.width = dimensions.width;
    tracks.video.height = dimensions.height;

    onProgress({ phase: 'remuxing', percent: 72, detail: 'Writing MP4 boxes' });
    await wait(work.phaseYieldMs);
    const mp4 = buildMp4(tracks);
    onProgress({ phase: 'remuxing', percent: 100, detail: 'MP4 remux complete' });
    return {
      bytes: mp4,
      mimeType: 'video/mp4',
      videoSampleCount: tracks.video.samples.length,
      audioSampleCount: tracks.audio.samples.length,
      width: tracks.video.width,
      height: tracks.video.height,
      hasAudio: tracks.audio.samples.length > 0,
      estimatedVideoFps: fps || estimateVideoFps(tracks.video.samples),
      videoDurationSeconds: quality.videoDurationSeconds,
      audioDurationSeconds: quality.audioDurationSeconds,
      keyFrameCount: quality.keyFrameCount,
      droppedVideoSamples: syncInfo.droppedVideoSamples,
      droppedAudioSamples: syncInfo.droppedAudioSamples,
      remuxWarnings: quality.warnings
    };
  }

  async function parseTransportStream(segmentBuffers, progressCb, work = remuxWorkTuning('balanced')) {
    const state = {
      pmtPid: null,
      videoPid: null,
      audioPid: null,
      pes: new Map(),
      video: { samples: [], sps: null, pps: null, width: 0, height: 0, unsupportedCodec: '' },
      audio: { samples: [], sampleRate: 0, channelConfig: 0, audioObjectType: 2, sampleRateIndex: 4, unsupportedCodec: '' }
    };

    let totalBytes = 0;
    for (const buffer of segmentBuffers) totalBytes += buffer.byteLength || buffer.length || 0;
    let parsedBytes = 0;

    for (let segmentIndex = 0; segmentIndex < segmentBuffers.length; segmentIndex += 1) {
      const source = segmentBuffers[segmentIndex];
      const data = source instanceof Uint8Array ? source : new Uint8Array(source);
      const start = findFirstSyncByte(data);
      if (start < 0) continue;
      for (let offset = start; offset + 188 <= data.length; offset += 188) {
        if (data[offset] !== 0x47) continue;
        parseTsPacket(data.subarray(offset, offset + 188), state);
      }
      parsedBytes += data.length;
      if (totalBytes) progressCb(parsedBytes / totalBytes);
      if (segmentIndex > 0 && segmentIndex % work.parseYieldEvery === 0) await wait(work.parseYieldMs);
    }

    flushPesForPid(state, state.videoPid);
    flushPesForPid(state, state.audioPid);
    return { video: state.video, audio: state.audio };
  }


  function remuxWorkTuning(mode) {
    if (mode === 'gentle') return { parseYieldEvery: 4, parseYieldMs: 8, phaseYieldMs: 12 };
    if (mode === 'fast') return { parseYieldEvery: 32, parseYieldMs: 0, phaseYieldMs: 0 };
    return { parseYieldEvery: 10, parseYieldMs: 2, phaseYieldMs: 4 };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function parseTsPacket(packet, state) {
    const payloadStart = Boolean(packet[1] & 0x40);
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const adaptationControl = (packet[3] >> 4) & 0x03;
    if (adaptationControl === 0 || adaptationControl === 2) return;
    let offset = 4;
    if (adaptationControl === 3) offset += 1 + packet[offset];
    if (offset >= packet.length) return;
    const payload = packet.subarray(offset);

    if (pid === 0) {
      if (payloadStart) parsePat(payload, state);
      return;
    }
    if (pid === state.pmtPid) {
      if (payloadStart) parsePmt(payload, state);
      return;
    }
    if (pid === state.videoPid || pid === state.audioPid) {
      collectPes(pid, payload, payloadStart, state);
    }
  }

  function parsePat(payload, state) {
    const table = psiTable(payload);
    if (!table || table[0] !== 0x00) return;
    const sectionLength = ((table[1] & 0x0f) << 8) | table[2];
    const end = Math.min(table.length, 3 + sectionLength - 4);
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      const programNumber = (table[offset] << 8) | table[offset + 1];
      const pid = ((table[offset + 2] & 0x1f) << 8) | table[offset + 3];
      if (programNumber !== 0) {
        state.pmtPid = pid;
        return;
      }
    }
  }

  function parsePmt(payload, state) {
    const table = psiTable(payload);
    if (!table || table[0] !== 0x02) return;
    const sectionLength = ((table[1] & 0x0f) << 8) | table[2];
    const programInfoLength = ((table[10] & 0x0f) << 8) | table[11];
    let offset = 12 + programInfoLength;
    const end = Math.min(table.length, 3 + sectionLength - 4);
    while (offset + 5 <= end) {
      const streamType = table[offset];
      const elementaryPid = ((table[offset + 1] & 0x1f) << 8) | table[offset + 2];
      const esInfoLength = ((table[offset + 3] & 0x0f) << 8) | table[offset + 4];
      if (streamType === 0x1b && state.videoPid == null) state.videoPid = elementaryPid;
      else if (streamType === 0x0f && state.audioPid == null) state.audioPid = elementaryPid;
      else if ((streamType === 0x24 || streamType === 0x02) && !state.video.unsupportedCodec) state.video.unsupportedCodec = streamType === 0x24 ? 'HEVC/H.265' : 'MPEG-2 video';
      else if (streamType === 0x11 && !state.audio.unsupportedCodec) state.audio.unsupportedCodec = 'AAC LATM/LOAS';
      else if ((streamType === 0x03 || streamType === 0x04) && !state.audio.unsupportedCodec) state.audio.unsupportedCodec = 'MPEG audio';
      else if ((streamType === 0x81 || streamType === 0x87) && !state.audio.unsupportedCodec) state.audio.unsupportedCodec = streamType === 0x81 ? 'AC-3 audio' : 'E-AC-3 audio';
      offset += 5 + esInfoLength;
    }
  }

  function psiTable(payload) {
    if (!payload.length) return null;
    const pointer = payload[0];
    const offset = 1 + pointer;
    if (offset >= payload.length) return null;
    return payload.subarray(offset);
  }

  function collectPes(pid, payload, payloadStart, state) {
    if (payloadStart) flushPesForPid(state, pid);
    if (!state.pes.has(pid)) state.pes.set(pid, []);
    state.pes.get(pid).push(payload);
  }

  function flushPesForPid(state, pid) {
    if (pid == null || !state.pes.has(pid)) return;
    const chunks = state.pes.get(pid);
    state.pes.delete(pid);
    const data = concat(chunks);
    const pes = parsePes(data);
    if (!pes) return;
    if (pid === state.videoPid) parseVideoPes(pes, state.video);
    if (pid === state.audioPid) parseAudioPes(pes, state.audio);
  }

  function parsePes(data) {
    if (data.length < 9 || data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) return null;
    const flags = data[7] || 0;
    const headerLength = data[8] || 0;
    const ptsDtsFlags = (flags >> 6) & 0x03;
    let pts = null;
    let dts = null;
    if (ptsDtsFlags === 2 || ptsDtsFlags === 3) {
      pts = readPts(data.subarray(9, 14));
      dts = pts;
      if (ptsDtsFlags === 3) dts = readPts(data.subarray(14, 19));
    }
    const payloadOffset = 9 + headerLength;
    if (payloadOffset > data.length) return null;
    return { pts, dts, data: data.subarray(payloadOffset) };
  }

  function readPts(bytes) {
    if (bytes.length < 5) return null;
    return ((bytes[0] & 0x0e) * 536870912) + (bytes[1] * 4194304) + ((bytes[2] & 0xfe) * 16384) + (bytes[3] * 128) + ((bytes[4] & 0xfe) >> 1);
  }

  function parseVideoPes(pes, video) {
    const nals = splitAnnexBNalus(pes.data);
    if (!nals.length) return;

    // Build one MP4 sample per H.264 access unit. Many MPEG-TS streams do not
    // include Access Unit Delimiter NALs, so split on the first VCL slice of a
    // new picture instead of treating an entire PES payload as one frame. This
    // fixes MP4s that opened but displayed as black/still video because hundreds
    // of real frames were packed into a few giant MP4 samples.
    const accessUnits = buildH264AccessUnits(nals, video);
    for (let index = 0; index < accessUnits.length; index += 1) {
      const unit = accessUnits[index];
      const hasPesTimestamp = index === 0;
      const sampleNals = unit.key && video.sps && video.pps
        ? prependParameterSets(unit.nals, video.sps, video.pps)
        : unit.nals;
      video.samples.push({
        data: lengthPrefixNalus(sampleNals),
        pts: hasPesTimestamp ? (pes.pts ?? pes.dts ?? null) : null,
        dts: hasPesTimestamp ? (pes.dts ?? pes.pts ?? null) : null,
        duration: 0,
        key: unit.key
      });
    }
  }

  function buildH264AccessUnits(nals, video) {
    const accessUnits = [];
    let current = { nals: [], key: false, hasVcl: false };
    const pushCurrent = () => {
      if (current.hasVcl && current.nals.length) accessUnits.push(current);
      current = { nals: [], key: false, hasVcl: false };
    };

    for (const rawNal of nals) {
      if (!rawNal.length) continue;
      const nal = trimTrailingZeros(rawNal);
      if (!nal.length) continue;
      const type = nal[0] & 0x1f;

      if (type === 7) {
        if (!video.sps) video.sps = nal;
        continue;
      }
      if (type === 8) {
        if (!video.pps) video.pps = nal;
        continue;
      }
      if (type === 9) {
        pushCurrent();
        continue;
      }

      const isVcl = type >= 1 && type <= 5;
      if (isVcl) {
        const firstMbInSlice = readFirstMbInSlice(nal);
        if (current.hasVcl && firstMbInSlice === 0) pushCurrent();
        current.nals.push(nal);
        current.hasVcl = true;
        if (type === 5) current.key = true;
        continue;
      }

      // Keep SEI and other non-parameter-set NALs attached to the nearest
      // access unit, but never let them create an MP4 sample by themselves.
      if (type === 6 || type === 12) {
        if (current.hasVcl) {
          pushCurrent();
        }
        current.nals.push(nal);
      }
    }
    pushCurrent();
    return accessUnits;
  }

  function readFirstMbInSlice(nal) {
    try {
      const rbsp = removeEmulationPreventionBytes(nal.subarray(1));
      const br = new BitReader(rbsp);
      return br.readUEG();
    } catch (_error) {
      return -1;
    }
  }

  function prependParameterSets(nals, sps, pps) {
    const hasSps = nals.some((nal) => (nal[0] & 0x1f) === 7);
    const hasPps = nals.some((nal) => (nal[0] & 0x1f) === 8);
    const prefix = [];
    if (!hasSps && sps) prefix.push(sps);
    if (!hasPps && pps) prefix.push(pps);
    return prefix.length ? [...prefix, ...nals] : nals;
  }

  function parseAudioPes(pes, audio) {
    let offset = 0;
    let frameIndex = 0;
    while (offset + 7 <= pes.data.length) {
      if (pes.data[offset] !== 0xff || (pes.data[offset + 1] & 0xf0) !== 0xf0) {
        offset += 1;
        continue;
      }
      const protectionAbsent = pes.data[offset + 1] & 0x01;
      const profileMinusOne = (pes.data[offset + 2] & 0xc0) >> 6;
      const sampleRateIndex = (pes.data[offset + 2] & 0x3c) >> 2;
      const channelConfig = ((pes.data[offset + 2] & 0x01) << 2) | ((pes.data[offset + 3] & 0xc0) >> 6);
      const frameLength = ((pes.data[offset + 3] & 0x03) << 11) | (pes.data[offset + 4] << 3) | ((pes.data[offset + 5] & 0xe0) >> 5);
      const headerLength = protectionAbsent ? 7 : 9;
      if (!frameLength || offset + frameLength > pes.data.length) break;
      const sampleData = pes.data.slice(offset + headerLength, offset + frameLength);
      const sampleRate = SAMPLE_RATES[sampleRateIndex] || 48000;
      audio.sampleRate = audio.sampleRate || sampleRate;
      audio.sampleRateIndex = sampleRateIndex;
      audio.channelConfig = audio.channelConfig || channelConfig || 2;
      audio.audioObjectType = (profileMinusOne + 1) || 2;
      const pts = pes.pts == null ? null : pes.pts + Math.round(frameIndex * 1024 * VIDEO_TIMESCALE / sampleRate);
      audio.samples.push({ data: sampleData, pts, dts: pts, duration: 1024 });
      frameIndex += 1;
      offset += frameLength;
    }
  }

  function normalizeVideoSamples(samples) {
    if (!samples.length) return;

    // Preserve access-unit order. Earlier builds sorted samples with null DTS as
    // zero, which could move most frames before their real timestamped PES
    // boundaries and create MP4 files that opened as black/still video. HLS TS
    // often timestamps only the first access unit in a PES packet, so interpolate
    // missing DTS values between known timestamp anchors instead of sorting.
    const defaultDuration = 3003; // about 29.97fps in the 90kHz clock.
    const anchors = [];
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].dts != null && Number.isFinite(samples[i].dts)) anchors.push(i);
    }

    if (!anchors.length) {
      for (let i = 0; i < samples.length; i += 1) {
        samples[i].dts = i * defaultDuration;
        samples[i].pts = samples[i].pts ?? samples[i].dts;
        samples[i].duration = defaultDuration;
        samples[i].cts = Math.max(0, samples[i].pts - samples[i].dts);
      }
      return;
    }

    const firstAnchor = anchors[0];
    for (let i = firstAnchor - 1; i >= 0; i -= 1) {
      samples[i].dts = Math.max(0, samples[i + 1].dts - defaultDuration);
      samples[i].pts = samples[i].pts ?? samples[i].dts;
    }

    for (let a = 0; a < anchors.length; a += 1) {
      const start = anchors[a];
      const end = anchors[a + 1] ?? samples.length;
      const nextAnchor = anchors[a + 1];
      const span = Math.max(1, (nextAnchor ?? end) - start);
      const step = nextAnchor != null
        ? Math.max(1, Math.round((samples[nextAnchor].dts - samples[start].dts) / span))
        : (samples[start - 1]?.duration || defaultDuration);
      for (let i = start + 1; i < end; i += 1) {
        samples[i].dts = samples[i - 1].dts + step;
        samples[i].pts = samples[i].pts ?? samples[i].dts;
      }
    }

    for (let i = 0; i < samples.length; i += 1) {
      const current = samples[i];
      const next = samples[i + 1];
      if (current.pts == null) current.pts = current.dts;
      current.duration = next ? Math.max(1, next.dts - current.dts) : (samples[i - 1]?.duration || defaultDuration);
      current.cts = Math.max(0, current.pts - current.dts);
    }
  }

  function normalizeAudioSamples(samples, sampleRate) {
    samples.sort((a, b) => (a.dts ?? 0) - (b.dts ?? 0));
    for (let i = 0; i < samples.length; i += 1) {
      const current = samples[i];
      current.duration = 1024;
      if (current.dts == null) current.dts = i ? samples[i - 1].dts + Math.round(1024 * VIDEO_TIMESCALE / sampleRate) : 0;
      current.pts = current.pts ?? current.dts;
    }
  }

  function estimateVideoFps(samples) {
    const duration = trackDuration90k(samples);
    if (!duration || !samples.length) return 0;
    return Math.round((samples.length * VIDEO_TIMESCALE / duration) * 100) / 100;
  }

  function alignTracksToFirstKeyframe(tracks) {
    const samples = tracks.video.samples;
    const firstKeyIndex = samples.findIndex((sample) => sample.key);
    if (firstKeyIndex < 0) {
      throw unsupported(
        'mp4-remux-no-keyframes',
        'The H.264 stream did not expose an IDR/keyframe. Media Scout stopped instead of saving an MP4 that would likely start as black video.'
      );
    }

    const baseDts = samples[firstKeyIndex].dts ?? 0;
    const droppedVideoSamples = firstKeyIndex;
    if (firstKeyIndex > 0) tracks.video.samples = samples.slice(firstKeyIndex);
    for (const sample of tracks.video.samples) {
      if (sample.dts != null) sample.dts = Math.max(0, sample.dts - baseDts);
      if (sample.pts != null) sample.pts = Math.max(0, sample.pts - baseDts);
    }

    const beforeAudio = tracks.audio.samples.length;
    if (beforeAudio) {
      tracks.audio.samples = tracks.audio.samples.filter((sample) => (sample.dts ?? 0) >= baseDts);
      for (const sample of tracks.audio.samples) {
        if (sample.dts != null) sample.dts = Math.max(0, sample.dts - baseDts);
        if (sample.pts != null) sample.pts = Math.max(0, sample.pts - baseDts);
      }
    }

    return { droppedVideoSamples, droppedAudioSamples: Math.max(0, beforeAudio - tracks.audio.samples.length) };
  }

  function assessRemuxQuality(tracks, expectedDurationSeconds) {
    const warnings = [];
    const videoDurationSeconds = Math.round((trackDuration90k(tracks.video.samples) / VIDEO_TIMESCALE) * 100) / 100;
    const audioDurationSeconds = tracks.audio.samples.length
      ? Math.round(((tracks.audio.samples.length * 1024) / (tracks.audio.sampleRate || 48000)) * 100) / 100
      : 0;
    const estimatedVideoFps = estimateVideoFps(tracks.video.samples);
    const keyFrameCount = tracks.video.samples.filter((sample) => sample.key).length;

    if (!tracks.video.samples.length) {
      return { ok: false, code: 'mp4-remux-no-video-after-keyframe-align', message: 'No decodable H.264 samples remained after aligning the stream to the first keyframe.' };
    }
    if (expectedDurationSeconds > 60 && estimatedVideoFps > 0 && estimatedVideoFps < 5) {
      return {
        ok: false,
        code: 'mp4-remux-too-few-video-samples',
        message: `The TS parser found only about ${estimatedVideoFps} video frame(s) per second for a ${Math.round(expectedDurationSeconds)}s playlist, which would likely produce a black/still MP4. Media Scout stopped instead of saving a broken file.`
      };
    }
    if (expectedDurationSeconds > 120 && videoDurationSeconds > 0 && videoDurationSeconds < expectedDurationSeconds * 0.35) {
      return {
        ok: false,
        code: 'mp4-remux-duration-mismatch',
        message: `The parsed video duration (${Math.round(videoDurationSeconds)}s) is far shorter than the playlist duration (${Math.round(expectedDurationSeconds)}s). Media Scout stopped instead of saving a likely broken MP4.`
      };
    }
    if (!tracks.audio.samples.length) warnings.push('No AAC audio samples were found in the selected TS segments.');
    if (tracks.audio.samples.length && videoDurationSeconds && Math.abs(videoDurationSeconds - audioDurationSeconds) > Math.max(8, videoDurationSeconds * 0.20)) {
      warnings.push(`Audio/video duration mismatch: video ${Math.round(videoDurationSeconds)}s, audio ${Math.round(audioDurationSeconds)}s.`);
    }
    return { ok: true, videoDurationSeconds, audioDurationSeconds, estimatedVideoFps, keyFrameCount, warnings };
  }

  function buildMp4(tracks) {
    const videoData = concat(tracks.video.samples.map((sample) => sample.data));
    const audioData = concat(tracks.audio.samples.map((sample) => sample.data));
    const ftypBox = ftyp();
    let moovBox = moov(tracks, { videoOffset: 0, audioOffset: 0 });
    const mdatHeaderSize = 8;
    const videoOffset = ftypBox.length + moovBox.length + mdatHeaderSize;
    const audioOffset = videoOffset + videoData.length;
    moovBox = moov(tracks, { videoOffset, audioOffset: audioData.length ? audioOffset : 0 });
    const mdatBox = box('mdat', videoData, audioData);
    return concat([ftypBox, moovBox, mdatBox]);
  }

  function ftyp() {
    return box('ftyp', ascii('isom'), u32(0x00000200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  }

  function moov(tracks, offsets) {
    const movieTimescale = 1000;
    const durationMs = Math.max(
      scaleDuration(trackDuration90k(tracks.video.samples), VIDEO_TIMESCALE, movieTimescale),
      tracks.audio.samples.length ? scaleDuration(tracks.audio.samples.length * 1024, tracks.audio.sampleRate || 48000, movieTimescale) : 0
    );
    const boxes = [mvhd(movieTimescale, durationMs), trakVideo(tracks.video, offsets.videoOffset, durationMs)];
    if (tracks.audio.samples.length && offsets.audioOffset) boxes.push(trakAudio(tracks.audio, offsets.audioOffset, durationMs));
    return box('moov', ...boxes);
  }

  function mvhd(timescale, duration) {
    return box('mvhd', u8(0), u24(0), u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), zeros(8), matrix(), zeros(24), u32(3));
  }

  function trakVideo(video, chunkOffset, movieDuration) {
    return box('trak', tkhd(1, movieDuration, video.width, video.height, true), mdiaVideo(video, chunkOffset));
  }

  function trakAudio(audio, chunkOffset, movieDuration) {
    return box('trak', tkhd(2, movieDuration, 0, 0, false), mdiaAudio(audio, chunkOffset));
  }

  function tkhd(trackId, duration, width, height, isVideo) {
    return box('tkhd', u8(0), u24(0x000007), u32(0), u32(0), u32(trackId), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0), matrix(), u32((width || 0) << 16), u32((height || 0) << 16));
  }

  function mdiaVideo(video, chunkOffset) {
    return box('mdia', mdhd(VIDEO_TIMESCALE, trackDuration90k(video.samples)), hdlr('vide', 'VideoHandler'), minfVideo(video, chunkOffset));
  }

  function mdiaAudio(audio, chunkOffset) {
    const sampleRate = audio.sampleRate || 48000;
    return box('mdia', mdhd(sampleRate, audio.samples.length * 1024), hdlr('soun', 'SoundHandler'), minfAudio(audio, chunkOffset));
  }

  function mdhd(timescale, duration) {
    return box('mdhd', u8(0), u24(0), u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
  }

  function hdlr(handler, name) {
    return box('hdlr', u8(0), u24(0), u32(0), ascii(handler), zeros(12), cstr(name));
  }

  function minfVideo(video, chunkOffset) {
    return box('minf', vmhd(), dinf(), stblVideo(video, chunkOffset));
  }

  function minfAudio(audio, chunkOffset) {
    return box('minf', smhd(), dinf(), stblAudio(audio, chunkOffset));
  }

  function vmhd() { return box('vmhd', u8(0), u24(1), u16(0), u16(0), u16(0), u16(0)); }
  function smhd() { return box('smhd', u8(0), u24(0), u16(0), u16(0)); }
  function dinf() { return box('dinf', box('dref', u8(0), u24(0), u32(1), box('url ', u8(0), u24(1)))); }

  function stblVideo(video, chunkOffset) {
    const parts = [stsdVideo(video), sttsVideo(video.samples), ctts(video.samples)];
    const sync = stss(video.samples);
    // If no IDR frames were confidently detected, omit stss so players treat
    // all samples as sync candidates instead of reading an empty sync table.
    if (sync) parts.push(sync);
    parts.push(stsc(video.samples.length), stsz(video.samples), stco(chunkOffset));
    return box('stbl', ...parts);
  }

  function stblAudio(audio, chunkOffset) {
    return box('stbl', stsdAudio(audio), sttsSingle(audio.samples.length, 1024), stsc(audio.samples.length), stsz(audio.samples), stco(chunkOffset));
  }

  function stsdVideo(video) {
    const avcC = avcCBox(video.sps, video.pps);
    const compressor = new Uint8Array(32);
    const name = ascii('Media Scout AVC');
    compressor[0] = Math.min(name.length, 31);
    compressor.set(name.subarray(0, 31), 1);
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(video.width), u16(video.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor, u16(0x0018), u16(0xffff), avcC);
    return box('stsd', u8(0), u24(0), u32(1), avc1);
  }

  function stsdAudio(audio) {
    const sampleRate = audio.sampleRate || 48000;
    const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channelConfig || 2), u16(16), u16(0), u16(0), u32(sampleRate << 16), esds(audio));
    return box('stsd', u8(0), u24(0), u32(1), mp4a);
  }

  function avcCBox(sps, pps) {
    const profile = sps[1] || 0x42;
    const compatibility = sps[2] || 0x00;
    const level = sps[3] || 0x1e;
    return box('avcC', u8(1), u8(profile), u8(compatibility), u8(level), u8(0xff), u8(0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);
  }

  function esds(audio) {
    const asc = audioSpecificConfig(audio.audioObjectType || 2, audio.sampleRateIndex ?? 4, audio.channelConfig || 2);
    const decoderSpecific = descriptor(0x05, asc);
    const decoderConfig = descriptor(0x04, u8(0x40), u8(0x15), u24(0), u32(0), u32(0), decoderSpecific);
    const es = descriptor(0x03, u16(1), u8(0), decoderConfig, descriptor(0x06, u8(2)));
    return box('esds', u8(0), u24(0), es);
  }

  function audioSpecificConfig(objectType, freqIndex, channelConfig) {
    const value = ((objectType & 0x1f) << 11) | ((freqIndex & 0x0f) << 7) | ((channelConfig & 0x0f) << 3);
    return u16(value);
  }

  function descriptor(tag, ...payloadParts) {
    const payload = concat(payloadParts);
    const sizeBytes = [];
    let size = payload.length;
    sizeBytes.unshift(size & 0x7f);
    size >>= 7;
    while (size > 0) {
      sizeBytes.unshift((size & 0x7f) | 0x80);
      size >>= 7;
    }
    return concat([u8(tag), new Uint8Array(sizeBytes), payload]);
  }

  function sttsVideo(samples) {
    const entries = [];
    for (const sample of samples) {
      const last = entries[entries.length - 1];
      if (last && last.duration === sample.duration) last.count += 1;
      else entries.push({ count: 1, duration: sample.duration });
    }
    const table = new Uint8Array(entries.length * 8);
    entries.forEach((entry, index) => {
      const offset = index * 8;
      writeU32(table, offset, entry.count);
      writeU32(table, offset + 4, entry.duration);
    });
    return box('stts', u8(0), u24(0), u32(entries.length), table);
  }

  function sttsSingle(count, duration) {
    return box('stts', u8(0), u24(0), u32(count ? 1 : 0), count ? u32(count) : zeros(0), count ? u32(duration) : zeros(0));
  }

  function ctts(samples) {
    const anyOffset = samples.some((sample) => sample.cts);
    if (!anyOffset) return box('ctts', u8(0), u24(0), u32(0));
    const entries = [];
    for (const sample of samples) {
      const offset = sample.cts || 0;
      const last = entries[entries.length - 1];
      if (last && last.offset === offset) last.count += 1;
      else entries.push({ count: 1, offset });
    }
    const table = new Uint8Array(entries.length * 8);
    entries.forEach((entry, index) => {
      const offset = index * 8;
      writeU32(table, offset, entry.count);
      writeU32(table, offset + 4, entry.offset);
    });
    return box('ctts', u8(0), u24(0), u32(entries.length), table);
  }

  function stss(samples) {
    const keys = [];
    samples.forEach((sample, index) => { if (sample.key) keys.push(index + 1); });
    if (!keys.length) return null;
    return box('stss', u8(0), u24(0), u32(keys.length), u32Array(keys));
  }

  function stsc(sampleCount) {
    return box('stsc', u8(0), u24(0), u32(sampleCount ? 1 : 0), sampleCount ? u32(1) : zeros(0), sampleCount ? u32(sampleCount) : zeros(0), sampleCount ? u32(1) : zeros(0));
  }

  function stsz(samples) {
    // Long HLS programs can contain hundreds of thousands of samples. Build the
    // table as one preallocated byte buffer instead of spreading per-sample
    // Uint8Arrays into a function call, which can exceed the JS call stack.
    const table = new Uint8Array(samples.length * 4);
    for (let i = 0; i < samples.length; i += 1) writeU32(table, i * 4, samples[i].data.length);
    return box('stsz', u8(0), u24(0), u32(0), u32(samples.length), table);
  }

  function stco(chunkOffset) {
    return box('stco', u8(0), u24(0), u32(chunkOffset ? 1 : 0), chunkOffset ? u32(chunkOffset) : zeros(0));
  }

  function trackDuration90k(samples) {
    return samples.reduce((sum, sample) => sum + (sample.duration || 0), 0);
  }

  function scaleDuration(value, fromTimescale, toTimescale) {
    return Math.round((value || 0) * toTimescale / fromTimescale);
  }

  function splitAnnexBNalus(data) {
    const starts = [];
    for (let i = 0; i + 3 < data.length; i += 1) {
      if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
        starts.push({ start: i, size: 3 });
        i += 2;
      } else if (i + 4 < data.length && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
        starts.push({ start: i, size: 4 });
        i += 3;
      }
    }
    const nals = [];
    for (let i = 0; i < starts.length; i += 1) {
      const start = starts[i].start + starts[i].size;
      const end = i + 1 < starts.length ? starts[i + 1].start : data.length;
      if (end > start) nals.push(data.subarray(start, end));
    }
    return nals;
  }

  function lengthPrefixNalus(nals) {
    const parts = [];
    for (const nal of nals) parts.push(u32(nal.length), nal);
    return concat(parts);
  }

  function trimTrailingZeros(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0x00) end -= 1;
    return bytes.slice(0, end);
  }

  function parseSpsDimensions(sps) {
    try {
      const rbsp = removeEmulationPreventionBytes(sps.subarray(1));
      const br = new BitReader(rbsp);
      const profileIdc = br.readBits(8);
      br.readBits(8); // constraint flags
      br.readBits(8); // level_idc
      br.readUEG();
      let chromaFormatIdc = 1;
      if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 144].includes(profileIdc)) {
        chromaFormatIdc = br.readUEG();
        if (chromaFormatIdc === 3) br.readBits(1);
        br.readUEG();
        br.readUEG();
        br.readBits(1);
        if (br.readBits(1)) skipScalingLists(br, chromaFormatIdc);
      }
      br.readUEG();
      const picOrderCntType = br.readUEG();
      if (picOrderCntType === 0) br.readUEG();
      else if (picOrderCntType === 1) {
        br.readBits(1); br.readSEG(); br.readSEG();
        const count = br.readUEG();
        for (let i = 0; i < count; i += 1) br.readSEG();
      }
      br.readUEG();
      br.readBits(1);
      const picWidthInMbsMinus1 = br.readUEG();
      const picHeightInMapUnitsMinus1 = br.readUEG();
      const frameMbsOnlyFlag = br.readBits(1);
      if (!frameMbsOnlyFlag) br.readBits(1);
      br.readBits(1);
      let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
      if (br.readBits(1)) {
        cropLeft = br.readUEG();
        cropRight = br.readUEG();
        cropTop = br.readUEG();
        cropBottom = br.readUEG();
      }
      const cropUnitX = chromaFormatIdc === 0 ? 1 : chromaFormatIdc === 3 ? 1 : 2;
      const cropUnitY = chromaFormatIdc === 0 ? 2 - frameMbsOnlyFlag : chromaFormatIdc === 1 ? 2 * (2 - frameMbsOnlyFlag) : 2 - frameMbsOnlyFlag;
      const width = ((picWidthInMbsMinus1 + 1) * 16) - (cropLeft + cropRight) * cropUnitX;
      const height = ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (cropTop + cropBottom) * cropUnitY;
      if (width > 0 && height > 0) return { width, height };
    } catch (_error) {
      return null;
    }
    return null;
  }

  function skipScalingLists(br, chromaFormatIdc) {
    const count = chromaFormatIdc !== 3 ? 8 : 12;
    for (let i = 0; i < count; i += 1) {
      if (!br.readBits(1)) continue;
      const size = i < 6 ? 16 : 64;
      let lastScale = 8;
      let nextScale = 8;
      for (let j = 0; j < size; j += 1) {
        if (nextScale !== 0) {
          const deltaScale = br.readSEG();
          nextScale = (lastScale + deltaScale + 256) % 256;
        }
        lastScale = nextScale === 0 ? lastScale : nextScale;
      }
    }
  }

  function removeEmulationPreventionBytes(data) {
    const out = [];
    for (let i = 0; i < data.length; i += 1) {
      if (i + 2 < data.length && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x03) {
        out.push(0x00, 0x00);
        i += 2;
      } else out.push(data[i]);
    }
    return new Uint8Array(out);
  }

  class BitReader {
    constructor(data) { this.data = data; this.index = 0; }
    readBits(count) {
      let value = 0;
      for (let i = 0; i < count; i += 1) {
        const byte = this.data[this.index >> 3] || 0;
        value = (value << 1) | ((byte >> (7 - (this.index & 7))) & 1);
        this.index += 1;
      }
      return value;
    }
    readUEG() {
      let zeros = 0;
      while (this.readBits(1) === 0 && zeros < 32) zeros += 1;
      return (1 << zeros) - 1 + (zeros ? this.readBits(zeros) : 0);
    }
    readSEG() {
      const value = this.readUEG();
      return value & 1 ? (value + 1) >> 1 : -(value >> 1);
    }
  }

  function parseResolutionHint(value) {
    const match = /([0-9]{2,5})\s*x\s*([0-9]{2,5})/i.exec(String(value || ''));
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  function findFirstSyncByte(data) {
    for (let i = 0; i < Math.min(data.length, 188); i += 1) {
      if (data[i] === 0x47 && data[i + 188] === 0x47) return i;
    }
    return data[0] === 0x47 ? 0 : -1;
  }

  function box(type, ...payloadParts) {
    const payload = concat(payloadParts);
    const out = new Uint8Array(8 + payload.length);
    writeU32(out, 0, out.length);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
  }

  function concat(parts) {
    const arrays = parts.filter(Boolean).map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
    const total = arrays.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of arrays) { out.set(part, offset); offset += part.length; }
    return out;
  }

  function ascii(value) {
    const out = new Uint8Array(String(value).length);
    for (let i = 0; i < out.length; i += 1) out[i] = String(value).charCodeAt(i) & 0xff;
    return out;
  }

  function cstr(value) {
    return concat([ascii(value), u8(0)]);
  }

  function zeros(length) { return new Uint8Array(length); }
  function u8(value) { return new Uint8Array([value & 0xff]); }
  function u16(value) { const out = new Uint8Array(2); out[0] = (value >>> 8) & 0xff; out[1] = value & 0xff; return out; }
  function u24(value) { const out = new Uint8Array(3); out[0] = (value >>> 16) & 0xff; out[1] = (value >>> 8) & 0xff; out[2] = value & 0xff; return out; }
  function u32(value) { const out = new Uint8Array(4); writeU32(out, 0, value); return out; }
  function u32Array(values) {
    const out = new Uint8Array(values.length * 4);
    for (let i = 0; i < values.length; i += 1) writeU32(out, i * 4, values[i]);
    return out;
  }
  function writeU32(out, offset, value) { out[offset] = (value >>> 24) & 0xff; out[offset + 1] = (value >>> 16) & 0xff; out[offset + 2] = (value >>> 8) & 0xff; out[offset + 3] = value & 0xff; }
  function matrix() { return concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]); }

  function unsupported(code, message) {
    const error = new Error(message);
    error.code = code;
    error.category = 'unsupported';
    return error;
  }

  globalThis.MediaScoutMp4Remuxer = Object.freeze({ remuxToMp4 });
})();
