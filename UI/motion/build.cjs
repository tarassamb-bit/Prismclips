const {buildSync} = require('esbuild');
const {mkdirSync, copyFileSync} = require('fs');
const path = require('path');
process.chdir(__dirname);
mkdirSync('runtime', {recursive:true});
buildSync({entryPoints:['engine-player.js'], bundle:true, minify:true, platform:'browser', format:'iife', loader:{'.woff2':'dataurl','.png':'dataurl'}, outfile:'runtime/engine-player.js'});
copyFileSync('node_modules/gsap/dist/gsap.min.js', 'runtime/gsap.min.js');
copyFileSync('node_modules/@hyperframes/core/dist/hyperframe.runtime.iife.js', 'runtime/hyperframe.runtime.iife.js');
