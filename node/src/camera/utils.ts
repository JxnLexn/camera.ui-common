import { isEqual } from '../utils/utils.js';

import type {
  AudioCodec,
  AudioCodecProperties,
  AudioFFmpegCodec,
  AudioStreamInfo,
  FMTPInfo,
  RTPInfo,
  VideoCodec,
  VideoCodecProperties,
  VideoFFmpegCodec,
  VideoStreamInfo,
} from '@camera.ui/sdk';

export function generateSdp(videos: VideoStreamInfo[], audios: AudioStreamInfo[]): string {
  const sdpLines: string[] = ['v=0', 'o=- ' + Date.now() + ' ' + Math.floor(Date.now() / 1000) + ' IN IP4 127.0.0.1', 's=Stream', 'c=IN IP4 0.0.0.0', 't=0 0'];

  // Video track
  for (const video of videos) {
    const videoCodec = video.codec;
    const videoPayloadType = video.properties.payloadType;
    const videoClockRate = video.properties.clockRate;
    const videoDirection = video.direction;
    const fmtp = video.properties.fmtpInfo;

    sdpLines.push(`m=video 0 RTP/AVP ${videoPayloadType}`);
    sdpLines.push('c=IN IP4 0.0.0.0');
    sdpLines.push(`a=rtpmap:${videoPayloadType} ${videoCodec}/${videoClockRate}`);

    if (fmtp) {
      sdpLines.push(`a=fmtp:${videoPayloadType} ${fmtp.config}`);
    }

    sdpLines.push(`a=${videoDirection}`);
  }

  // Audio track
  for (const audio of audios) {
    const audioCodec = audio.codec;
    const audioPayloadType = audio.properties.payloadType;
    const audioSampleRate = audio.properties.sampleRate;
    const audioChannels = audio.properties.channels;
    const audioDirection = audio.direction;
    const fmtp = audio.properties.fmtpInfo;

    sdpLines.push(`m=audio 0 RTP/AVP ${audioPayloadType}`);
    sdpLines.push('c=IN IP4 0.0.0.0');
    sdpLines.push(`a=rtpmap:${audioPayloadType} ${audioCodec}/${audioSampleRate}${audioChannels > 1 ? `/${audioChannels}` : ''}`);

    if (fmtp) {
      sdpLines.push(`a=fmtp:${audioPayloadType} ${fmtp.config}`);
    }

    sdpLines.push(`a=${audioDirection}`);
  }

  return sdpLines.join('\n');
}

export function extractSdpInfo(producers: { sdp?: string }[]): {
  video: Record<string, Record<string, any>>;
  audio: Record<string, Record<string, any>>;
} {
  const sdpInfo = {
    video: {} as Record<string, Record<string, any>>,
    audio: {} as Record<string, Record<string, any>>,
  };

  for (const producer of producers) {
    if (!producer.sdp) continue;

    const sdpLines = producer.sdp.split(/\r?\n/);
    let currentMedia: 'video' | 'audio' | null = null;
    let currentCodec = '';

    for (let i = 0; i < sdpLines.length; i++) {
      const line = sdpLines[i].trim();

      // Check for media type
      if (line.startsWith('m=')) {
        const mediaParts = line.split(' ');
        if (mediaParts.length >= 4) {
          const mediaType = mediaParts[0].substring(2) as 'audio' | 'video';
          if (mediaType === 'audio' || mediaType === 'video') {
            currentMedia = mediaType;
          } else {
            currentMedia = null;
          }
        }
      } else if (currentMedia && line.startsWith('a=rtpmap:')) {
        // Check for codec information
        const rtpMapMatch = /a=rtpmap:(\d+)\s+([^/]+)\/(\d+)(?:\/(\d+))?/.exec(line);
        if (rtpMapMatch) {
          const payload = parseInt(rtpMapMatch[1], 10);
          const codecName = rtpMapMatch[2].toUpperCase();
          const clockRate = parseInt(rtpMapMatch[3], 10);
          const channels = rtpMapMatch[4] ? parseInt(rtpMapMatch[4], 10) : 1;

          // Initialize codec object if not present
          if (!sdpInfo[currentMedia][codecName]) {
            sdpInfo[currentMedia][codecName] = {};
          }

          sdpInfo[currentMedia][codecName].payload = payload;
          sdpInfo[currentMedia][codecName].clockRate = clockRate;

          if (currentMedia === 'audio') {
            sdpInfo[currentMedia][codecName].channels = channels;
          }

          // Set current codec - we'll use this for subsequent fmtp lines
          currentCodec = codecName;
        }
      } else if (currentMedia && currentCodec && line.startsWith('a=fmtp:')) {
        // Check for fmtp information
        const fmtpMatch = /a=fmtp:(\d+)\s+(.*)/.exec(line);
        if (fmtpMatch) {
          const payload = parseInt(fmtpMatch[1], 10);

          // Check if this fmtp line is for the current codec
          if (sdpInfo[currentMedia][currentCodec]?.payload === payload) {
            const params = fmtpMatch[2];

            // Store fmtp params
            sdpInfo[currentMedia][currentCodec].fmtp = params;
            sdpInfo[currentMedia][currentCodec].fmtpPayload = payload; // Store payload for reference

            // For H.264/H.265, extract profile-level-id
            if ((currentCodec === 'H264' || currentCodec === 'H265') && currentMedia === 'video') {
              const paramMap: Record<string, string> = {};
              const paramPairs = params.split(';');

              for (const pair of paramPairs) {
                const [key, value] = pair.split('=').map((s) => s.trim());
                if (key && value) {
                  paramMap[key] = value;
                }
              }

              if (paramMap['profile-level-id']) {
                sdpInfo[currentMedia][currentCodec].profileLevelId = paramMap['profile-level-id'];
              }

              // For H.264/H,265, extract sprop-parameter-sets, sprop-vps, sprop-sps, sprop-pps
              ['sprop-parameter-sets', 'sprop-vps', 'sprop-sps', 'sprop-pps'].forEach((param) => {
                if (paramMap[param]) {
                  sdpInfo[currentMedia!][currentCodec][param] = paramMap[param];
                }
              });
            }

            // For MPEG4-GENERIC, extract config
            if (currentCodec === 'MPEG4-GENERIC' && currentMedia === 'audio') {
              const paramMap: Record<string, string> = {};
              const paramPairs = params.split(';');

              for (const pair of paramPairs) {
                const [key, value] = pair.split('=').map((s) => s.trim());
                if (key && value) {
                  paramMap[key] = value;
                }
              }

              if (paramMap.config) {
                sdpInfo[currentMedia][currentCodec].config = paramMap.config;
              }
            }
          }
        }
      }
    }
  }

  return sdpInfo;
}

export function getAudioCodecProperties(codecName: AudioCodec, rtp?: RTPInfo, fmtp?: FMTPInfo): AudioCodecProperties {
  const defaultCodecProperties: Record<AudioCodec, AudioCodecProperties> = {
    PCMU: { sampleRate: 8000, channels: 1, payloadType: 0 },
    PCMA: { sampleRate: 8000, channels: 1, payloadType: 8 },
    'MPEG4-GENERIC': {
      sampleRate: 16000,
      channels: 1,
      payloadType: 97,
      fmtpInfo: { payload: 97, config: 'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=1408' },
    },
    opus: { sampleRate: 48000, channels: 2, payloadType: 101, fmtpInfo: { payload: 101, config: 'minptime=10;useinbandfec=1' } },
    G722: { sampleRate: 8000, channels: 1, payloadType: 9 },
    G726: { sampleRate: 8000, channels: 1, payloadType: 96 },
    MPA: { sampleRate: 48000, channels: 2, payloadType: 14 },
    PCM: { sampleRate: 48000, channels: 1, payloadType: 10 },
    FLAC: { sampleRate: 48000, channels: 2, payloadType: 98 },
    ELD: { sampleRate: 16000, channels: 1, payloadType: 97 },
    PCML: { sampleRate: 48000, channels: 1, payloadType: 10 },
    L16: { sampleRate: 48000, channels: 2, payloadType: 98 },
  };

  const fallbackProperties = defaultCodecProperties.PCM;

  if (!rtp) {
    return defaultCodecProperties[codecName] ?? fallbackProperties;
  }

  const defaultProps = defaultCodecProperties[codecName] ?? fallbackProperties;

  // Take data from RTP if available, otherwise use default
  const sampleRate = rtp.rate ?? defaultProps.sampleRate;
  const channels = rtp.encoding ?? defaultProps.channels;
  const payloadType = rtp.payload ?? defaultProps.payloadType;

  // If fmtp is available, set the payload value to the main payload type
  let fmtpInfo = fmtp;
  if (fmtpInfo) {
    fmtpInfo = { ...fmtpInfo, payload: payloadType };
  } else if (defaultProps.fmtpInfo) {
    // If no fmtp is specified, but available by default, copy and update the payload type
    fmtpInfo = {
      ...defaultProps.fmtpInfo,
      payload: payloadType,
    };
  }

  return {
    sampleRate,
    channels,
    payloadType,
    fmtpInfo,
  };
}

export function getVideoCodecProperties(codecName: VideoCodec, rtp?: RTPInfo, fmtp?: FMTPInfo): VideoCodecProperties {
  const defaultCodecProperties: Record<VideoCodec, VideoCodecProperties> = {
    H264: { clockRate: 90000, payloadType: 96, fmtpInfo: { payload: 96, config: 'packetization-mode=1;profile-level-id=42e01f' } },
    H265: { clockRate: 90000, payloadType: 96 },
    VP8: { clockRate: 90000, payloadType: 96 },
    VP9: { clockRate: 90000, payloadType: 96 },
    AV1: { clockRate: 90000, payloadType: 96 },
    JPEG: { clockRate: 90000, payloadType: 96 },
    RAW: { clockRate: 90000, payloadType: 96 },
  };

  const fallbackProperties = defaultCodecProperties.H264;

  if (!rtp) {
    return defaultCodecProperties[codecName] ?? fallbackProperties;
  }

  const defaultProps = defaultCodecProperties[codecName] ?? fallbackProperties;

  // Take data from RTP if available, otherwise use default
  const clockRate = rtp.rate ?? defaultProps.clockRate;
  const payloadType = rtp.payload ?? defaultProps.payloadType;

  // If fmtp is available, set the payload value to the main payload type
  let fmtpInfo = fmtp;
  if (fmtpInfo) {
    fmtpInfo = { ...fmtpInfo, payload: payloadType };
  } else if (defaultProps.fmtpInfo) {
    // If no fmtp is specified, but available by default, copy and update the payload type
    fmtpInfo = {
      ...defaultProps.fmtpInfo,
      payload: payloadType,
    };
  }

  return {
    clockRate,
    payloadType,
    fmtpInfo,
  };
}

export function extractProfileFromProfileLevelId(profileLevelId: string): string | undefined {
  if (!profileLevelId || profileLevelId.length < 6) return undefined;

  const profileByte = profileLevelId.substring(0, 2).toUpperCase();
  switch (profileByte) {
    case '42':
      return 'Baseline';
    case '4D':
      return 'Main';
    case '64':
      return 'High';
    default:
      return undefined;
  }
}

export function extractLevelFromProfileLevelId(profileLevelId: string): number | undefined {
  if (!profileLevelId || profileLevelId.length < 6) return undefined;

  try {
    // Take last 2 charactersas hex and convert to number
    const levelHex = profileLevelId.substring(profileLevelId.length - 2);
    return parseInt(levelHex, 16);
  } catch {
    return undefined;
  }
}

export function createProfileLevelId(profile: string, level: number): string | undefined {
  const profileMap: Record<string, string> = {
    Baseline: '42',
    Main: '4D',
    High: '64',
  };

  const profileId = profileMap[profile];
  if (!profileId) return undefined;

  // Format level as hex, ensure it's 2 digits
  const levelHex = level.toString(16).padStart(2, '0');

  return `${profileId}00${levelHex}`;
}

export function normalizeAudioCodecs(audioCodec: AudioCodec): {
  codec: AudioCodec;
  ffmpegCodec: AudioFFmpegCodec;
} {
  let codec: AudioCodec;
  let ffmpegCodec: AudioFFmpegCodec;

  switch (audioCodec) {
    case 'PCMU':
      codec = 'PCMU';
      ffmpegCodec = 'pcm_mulaw';
      break;
    case 'PCMA':
      codec = 'PCMA';
      ffmpegCodec = 'pcm_alaw';
      break;
    case 'MPEG4-GENERIC':
    case 'ELD':
      codec = 'MPEG4-GENERIC';
      ffmpegCodec = 'aac';
      break;
    case 'opus':
      codec = 'opus';
      ffmpegCodec = 'libopus';
      break;
    case 'G722':
      codec = 'G722';
      ffmpegCodec = 'g722';
      break;
    case 'G726':
      codec = 'G726';
      ffmpegCodec = 'g726';
      break;
    case 'MPA':
      codec = 'MPA';
      ffmpegCodec = 'mp3';
      break;
    case 'L16':
      codec = 'PCM';
      ffmpegCodec = 'pcm_s16be';
      break;
    case 'PCML':
      codec = 'PCM';
      ffmpegCodec = 'pcm_s16le';
      break;
    case 'FLAC':
      codec = 'FLAC';
      ffmpegCodec = 'flac';
      break;
    default:
      codec = 'PCM';
      ffmpegCodec = 'pcm_s16le';
      break;
  }

  return { codec, ffmpegCodec };
}

export function normalizeVideoCodecs(videoCodec: VideoCodec): {
  codec: VideoCodec;
  ffmpegCodec: VideoFFmpegCodec;
} {
  let codec: VideoCodec;
  let ffmpegCodec: VideoFFmpegCodec;

  switch (videoCodec) {
    case 'H264':
      codec = 'H264';
      ffmpegCodec = 'h264';
      break;
    case 'H265':
      codec = 'H265';
      ffmpegCodec = 'hevc';
      break;
    case 'VP8':
      codec = 'VP8';
      ffmpegCodec = 'vp8';
      break;
    case 'VP9':
      codec = 'VP9';
      ffmpegCodec = 'vp9';
      break;
    case 'AV1':
      codec = 'AV1';
      ffmpegCodec = 'av1';
      break;
    case 'JPEG':
      codec = 'JPEG';
      ffmpegCodec = 'mjpeg';
      break;
    case 'RAW':
      codec = 'RAW';
      ffmpegCodec = 'rawvideo';
      break;
    default:
      codec = 'H264';
      ffmpegCodec = 'h264';
      break;
  }

  return { codec, ffmpegCodec };
}

export function parseFmtpConfig(config: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = config.split(';');

  for (const pair of pairs) {
    const [key, value] = pair.trim().split('=');
    if (key && value !== undefined) {
      params[key.trim()] = value.trim();
    }
  }

  return params;
}

export function mapAudioCodecName(codecName: string): AudioCodec | undefined {
  if (!codecName) return undefined;

  const codecMap: Record<string, AudioCodec> = {
    pcm_mulaw: 'PCMU',
    pcmu: 'PCMU',
    pcm_ulaw: 'PCMU',
    pcm_alaw: 'PCMA',
    pcma: 'PCMA',
    aac: 'MPEG4-GENERIC',
    'mpeg4-generic': 'MPEG4-GENERIC',
    libopus: 'opus',
    opus: 'opus',
    OPUS: 'opus',
    g722: 'G722',
    g726: 'G726',
    'g726-40': 'G726',
    'g726-32': 'G726',
    'g726-24': 'G726',
    'g726-16': 'G726',
    mp3: 'MPA',
    mpa: 'MPA',
    pcm_s16be: 'PCM',
    pcm_s16le: 'PCM',
    pcm: 'PCM',
    l16: 'L16',
    flac: 'FLAC',
  };

  return codecMap[codecName.toLowerCase()];
}

export function mapVideoCodecName(codecName: string): VideoCodec | undefined {
  if (!codecName) return undefined;

  const codecMap: Record<string, VideoCodec> = {
    h264: 'H264',
    hevc: 'H265',
    h265: 'H265',
    vp8: 'VP8',
    vp9: 'VP9',
    av1: 'AV1',
    mjpeg: 'JPEG',
    jpeg: 'JPEG',
    rawvideo: 'RAW',
  };

  return codecMap[codecName.toLowerCase()];
}

export function mapDirection(direction: string): 'sendonly' | 'recvonly' | 'sendrecv' | 'inactive' {
  switch (direction) {
    case 'sendonly':
    case 'recvonly':
    case 'sendrecv':
    case 'inactive':
      return direction;
    default:
      return 'sendrecv'; // Default to sendrecv if direction is unknown
  }
}

export function transformAudioStreamInfoToFFmpegArgs(audioStreamInfo: AudioStreamInfo): string[] {
  const sampleRate = audioStreamInfo.properties.sampleRate.toString();
  const channel = audioStreamInfo.properties.channels.toString();
  const returnAudioCodec = audioStreamInfo.ffmpegCodec;
  const returnAudioCodecs: string[] = [];

  switch (returnAudioCodec) {
    case 'aac':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate, '-b:a', sampleRate);
      break;
    case 'libopus':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate, '-b:a', sampleRate, '-application', 'lowdelay');
      break;
    case 'pcm_mulaw':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'pcm_alaw':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'pcm_s16le':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'pcm_s16be':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'g722':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'g726':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'mp3':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    case 'flac':
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
      break;
    default:
      returnAudioCodecs.push('-acodec', returnAudioCodec, '-ac', channel, '-ar', sampleRate);
  }

  return returnAudioCodecs;
}

export function isSameVideoStreamInfo(a: VideoStreamInfo, b: VideoStreamInfo): boolean {
  return isEqual(a, b, true);
}

export function isSameAudioStreamInfo(a: AudioStreamInfo, b: AudioStreamInfo): boolean {
  return isEqual(a, b, true);
}
