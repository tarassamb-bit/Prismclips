// A YouTube link as a video file: the server copies the picture and the sound into the account's cloud storage (api/youtube.js),
// this downloads both, joins them into one MP4 without re-encoding, and deletes the two parts again.
import { mediabunny } from './engine/media.js';
import { downloadVideo, removeVideos } from './cloudvideo.js';

async function copyPart(token, url, part, signal) {
  const response = await fetch(`/api/youtube?part=${part}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ url }), signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered ${response.status}.`);
  return data;
}

/** One MP4 from separate picture and sound files, packets copied as they are. */
export async function joinParts(videoBlob, audioBlob) {
  const { Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource } = await mediabunny();
  const video = await new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) }).getPrimaryVideoTrack();
  const audio = await new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob) }).getPrimaryAudioTrack();
  if (!video || !audio) throw new Error('YouTube sent a file this browser can’t read. Download the video and upload it instead.');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoOut = new EncodedVideoPacketSource(video.codec), audioOut = new EncodedAudioPacketSource(audio.codec);
  output.addVideoTrack(videoOut, { rotation: video.rotation });
  output.addAudioTrack(audioOut);
  await output.start();
  const copy = async (track, out) => {
    const decoderConfig = await track.getDecoderConfig();
    let first = true;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await out.add(packet, first ? { decoderConfig } : undefined);
      first = false;
    }
    out.close();
  };
  await Promise.all([copy(video, videoOut), copy(audio, audioOut)]);
  await output.finalize();
  return output.target.buffer;
}

/** The linked video as a File, ready for chooseVideo. `onStatus` gets a short line for the screen. */
export async function videoFromLink({ token, url, onStatus, signal }) {
  onStatus('Getting the video from YouTube…');
  // Two calls side by side, so each gets the server's full time limit.
  const results = await Promise.allSettled([copyPart(token, url, 'video', signal), copyPart(token, url, 'audio', signal)]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    const copied = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.mediaId);
    if (copied.length) removeVideos({ token, mediaIds: copied }).catch(() => {});
    throw failed.reason;
  }
  const [video, audio] = results.map((r) => r.value);
  try {
    onStatus('Downloading the video…');
    const [videoBlob, audioBlob] = await Promise.all([
      downloadVideo({ token, mediaId: video.mediaId, type: video.type, size: video.bytes, signal }),
      downloadVideo({ token, mediaId: audio.mediaId, type: audio.type, size: audio.bytes, signal }),
    ]);
    onStatus('Preparing the video…');
    const buffer = await joinParts(videoBlob, audioBlob);
    const name = `${video.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'YouTube video'}.mp4`;
    return new File([buffer], name, { type: 'video/mp4' });
  } finally {
    // The parts only existed to reach this browser; the joined file is saved to the account like any upload.
    removeVideos({ token, mediaIds: [video.mediaId, audio.mediaId] }).catch(() => {});
  }
}
