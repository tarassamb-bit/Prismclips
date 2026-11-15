import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Remotion from 'remotion';
import {Player} from '@remotion/player';
import * as Babel from '@babel/standalone';
import '@hyperframes/player';
import {toJpeg} from 'html-to-image';
import spaceGrotesk from '../fonts/SpaceGrotesk-Medium.woff2';
import soraRegular from '../fonts/Sora-Regular.woff2';
import soraMedium from '../fonts/Sora-Medium.woff2';
import relioIcon from '../icon.png';

// Data URLs keep the same brand fonts available inside opaque-origin sandboxed frames.
const brandFontCss = `
@font-face{font-family:'Space Grotesk';src:url(${spaceGrotesk}) format('woff2');font-weight:500;font-style:normal}
@font-face{font-family:'Sora';src:url(${soraRegular}) format('woff2');font-weight:400;font-style:normal}
@font-face{font-family:'Sora';src:url(${soraMedium}) format('woff2');font-weight:500 700;font-style:normal}`;
const fontStyle = document.createElement('style');
fontStyle.textContent = brandFontCss;
document.head.append(fontStyle);

// Optional elements for Relio-specific briefs. They are normal React components,
// so generated compositions can position, animate or replace them as needed.
const Relio = Object.freeze({
  Logo({size = 120, style = {}}) {
    return React.createElement('img', {src: relioIcon, alt:'', style:{width:size, height:size, borderRadius:size * .23, objectFit:'cover', display:'block', ...style}});
  },
  CaptionBars({width = 260, color = '#f3f0e9', style = {}}) {
    return React.createElement('div', {style:{display:'flex', flexDirection:'column', gap:10, width, ...style}},
      [1, .78, .54].map((length, index) => React.createElement('div', {key:index, style:{width:`${length * 100}%`, height:12, borderRadius:8, background:color, opacity:1 - index * .18}})));
  },
  ShortCard({width = 480, heading = '', caption = '', style = {}}) {
    const size = Number(width) || 480;
    return React.createElement('div', {style:{position:'relative', width:size, height:size * 1.65, overflow:'hidden', borderRadius:size * .075, border:`${Math.max(3, size * .01)}px solid #505767`, background:'linear-gradient(155deg,#303c4e 0%,#1a1c22 60%,#0e1017 100%)', boxShadow:'0 28px 65px rgba(0,0,0,.25)', color:'#f3f0e9', fontFamily:'Sora, sans-serif', ...style}},
      React.createElement('div', {style:{position:'absolute', inset:`${size * .055}px`, borderRadius:size * .035, border:'1px solid rgba(255,255,255,.1)'}}),
      React.createElement('div', {style:{position:'absolute', left:'9%', top:'7%', display:'flex', alignItems:'center', gap:size * .025}},
        React.createElement(Relio.Logo, {size:size * .09}), React.createElement('span', {style:{fontSize:size * .035, fontWeight:500}}, 'Relio Clips')),
      React.createElement('div', {style:{position:'absolute', left:'10%', right:'10%', bottom:'12%'}},
        heading ? React.createElement('div', {style:{fontFamily:'Space Grotesk, sans-serif', fontSize:size * .085, lineHeight:1.08, fontWeight:500, overflowWrap:'break-word'}}, heading) : null,
        caption ? React.createElement('div', {style:{marginTop:size * .04, display:'inline-block', padding:`${size * .018}px ${size * .035}px`, borderRadius:8, background:'#3fa9f5', color:'#0e1017', fontSize:size * .035, fontWeight:600}}, caption) : null));
  },
});

const root = createRoot(document.getElementById('root'));
const say = (message) => parent.postMessage(message, '*');
let failed = false, ready = false, activePlayer = null, activeEngine = null, totalDuration = 0;
function playbackUpdate(time, playing) { say({type:'playback', time, playing}); }
function reportError(error) {
  if (failed) return;
  failed = true;
  say({type:'error', message:String(error?.message || error || 'Preview failed')});
}
function reportReady(duration, fps = 30) {
  if (failed || ready) return;
  ready = true;
  say({type:'ready', duration, fps});
}
function Failed({error}) {
  React.useEffect(() => { reportError(error); }, [error]);
  return null;
}
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = {error: false}; }
  static getDerivedStateFromError() { return {error: true}; }
  componentDidCatch(error) { reportError(error); }
  render() { return this.state.error ? null : this.props.children; }
}
async function captureFrames(requestId) {
  if (!activePlayer || !totalDuration) throw new Error('The preview is not ready to review.');
  const isRemotion = activeEngine === 'remotion';
  const wasPlaying = isRemotion ? activePlayer.isPlaying() : !activePlayer.paused;
  const original = isRemotion ? activePlayer.getCurrentFrame() / 30 : activePlayer.currentTime;
  const frames = [];
  activePlayer.pause();
  try {
    for (const fraction of [0.02, 0.24, 0.48, 0.72, 0.96]) {
      const time = Math.min(totalDuration - 1 / 30, Math.max(0, totalDuration * fraction));
      if (isRemotion) activePlayer.seekTo(Math.round(time * 30)); else activePlayer.seek(time);
      await new Promise(resolve => setTimeout(resolve, 150));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const target = isRemotion ? document.getElementById('root') : activePlayer.iframeElement?.contentDocument?.body;
      if (!target) throw new Error('The video frame could not be accessed.');
      const image = await toJpeg(target, {width:1080, height:1920, canvasWidth:360, canvasHeight:640, pixelRatio:1, quality:.7, fontEmbedCSS:brandFontCss});
      if (!image.startsWith('data:image/jpeg;base64,')) throw new Error('The video frame was empty.');
      frames.push({time, image});
    }
    say({type:'review-frames', requestId, frames});
  } catch (error) { say({type:'review-capture-error', requestId, message:String(error?.message || error)}); }
  finally {
    if (isRemotion) activePlayer.seekTo(Math.round(original * 30)); else activePlayer.seek(original);
    if (wasPlaying) activePlayer.play();
  }
}
window.addEventListener('error', (event) => reportError(event.message));
window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const m = event.data || {};
  if (m.type === 'capture-review') { captureFrames(m.requestId); return; }
  if (m.type === 'playback-control' && activePlayer) {
    if (activeEngine === 'remotion') {
      if (m.action === 'play') activePlayer.play();
      if (m.action === 'pause') activePlayer.pause();
      if (m.action === 'seek') activePlayer.seekTo(Math.max(0, Math.min(Math.ceil(totalDuration * 30) - 1, Math.round(Number(m.time) * 30))));
    } else {
      if (m.action === 'play') activePlayer.play();
      if (m.action === 'pause') activePlayer.pause();
      if (m.action === 'seek') activePlayer.seek(Number(m.time));
    }
    return;
  }
  if (m.type !== 'load') return;
  const {code, engine} = m;
  try {
    if (engine === 'remotion') {
      Promise.all([document.fonts.load('500 24px "Space Grotesk"'), document.fonts.load('400 24px Sora'), document.fonts.load('500 24px Sora')]).then(() => {
      const compiled = Babel.transform(code, {presets:['react'], sourceType:'script'}).code;
      const composition = new Function('React', 'Remotion', 'Relio', `${compiled}\n;return {Video, durationInFrames: typeof durationInFrames === 'undefined' ? 300 : durationInFrames};`)(React, Remotion, Relio);
      const duration = Number(composition.durationInFrames);
      if (typeof composition.Video !== 'function' || !Number.isInteger(duration) || duration < 30 || duration > 1800) throw new Error('The composition must define Video and a durationInFrames between 30 and 1800.');
      // Report success only after the generated component itself has mounted. Remotion
      // catches composition errors internally, so a sibling effect can report a false success.
      function VideoWithReady(props) {
        React.useEffect(() => { reportReady(duration / 30); }, []);
        return React.createElement(composition.Video, props);
      }
      totalDuration = duration / 30;
      activeEngine = 'remotion';
      function bindPlayer(ref) {
        if (!ref || ref === activePlayer) return;
        activePlayer = ref;
        const update = () => playbackUpdate(ref.getCurrentFrame() / 30, ref.isPlaying());
        ['timeupdate', 'seeked', 'play', 'pause', 'ended'].forEach((name) => ref.addEventListener(name, update));
      }
      root.render(React.createElement(Boundary, {key: Date.now()}, React.createElement(Player, {
        component:VideoWithReady, durationInFrames:duration, compositionWidth:1080, compositionHeight:1920, fps:30,
        autoPlay:true, loop:true, controls:false, ref:bindPlayer, style:{width:'100%',height:'100%'},
        errorFallback:({error}) => React.createElement(Failed, {error}),
      })));
      }).catch(reportError);
    } else if (engine === 'hyperframes') {
      root.unmount();
      const player = document.createElement('hyperframes-player');
      player.setAttribute('width','1080'); player.setAttribute('height','1920');
      player.setAttribute('autoplay',''); player.setAttribute('loop','');
      activeEngine = 'hyperframes'; activePlayer = player;
      ['timeupdate', 'play', 'pause', 'ended'].forEach((name) => player.addEventListener(name, () => playbackUpdate(player.currentTime || 0, !player.paused)));
      player.style.cssText = 'width:100%;height:100%;display:block';
      player.addEventListener('ready', (e) => {
        const duration = Number(e.detail?.duration);
        if (Number.isFinite(duration) && duration > 0) { totalDuration = duration; reportReady(duration); }
        else reportError('The HyperFrames composition has no valid duration.');
      }, {once:true});
      player.addEventListener('error', (e) => reportError(e.detail?.message || 'HyperFrames preview failed.'));
      window.addEventListener('message', (childEvent) => {
        if (childEvent.source === player.iframeElement?.contentWindow && childEvent.data?.type === 'relio-hyperframes-error') reportError(childEvent.data.message);
      });
      const bridge = `<script>addEventListener('error',function(e){parent.postMessage({type:'relio-hyperframes-error',message:String(e.message||'Composition failed')},'*')});addEventListener('unhandledrejection',function(e){parent.postMessage({type:'relio-hyperframes-error',message:String(e.reason&&e.reason.message||e.reason||'Composition failed')},'*')});<\/script>`;
      const gsap = '<style>' + brandFontCss + '</style>' + bridge + '<script src="/motion/runtime/gsap.min.js"><\/script>';
      const runtime = '<script src="/motion/runtime/hyperframe.runtime.iife.js"><\/script>';
      const withGsap = /<head[^>]*>/i.test(code) ? code.replace(/<head[^>]*>/i, '$&' + gsap) : gsap + code;
      player.setAttribute('srcdoc', /<\/body>/i.test(withGsap) ? withGsap.replace(/<\/body>/i, runtime + '</body>') : withGsap + runtime);
      document.body.replaceChildren(player);
    }
  } catch (error) { reportError(error); }
});
