// Returns user-provided reference drawing code for an isolated, local-only style preview.
const {HttpError, send, fail} = require('./_lib');
const fs = require('fs');
const path = require('path');
const FILES = Object.freeze({'flat-vector-science':'flat-vector-science.txt','watercolor-wash':'watercolor-wash.txt','shadow-puppet-theatre':'shadow-puppet-theatre.txt'});
module.exports = async (req, res) => {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''))) throw new HttpError(404, 'Not found.');
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
    let body=''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new HttpError(413, 'Request too large.'); }
    let data; try {data=JSON.parse(body)} catch {throw new HttpError(400,'Invalid request.');}
    if (!Object.hasOwn(FILES,data.style)) throw new HttpError(400,'Unknown video style.');
    const source=fs.readFileSync(path.join(__dirname,'_motion-styles',FILES[data.style]),'utf8');
    function block(header) {
      const at=source.indexOf(header); if(at<0)throw new Error('Reference section missing.');
      const match=source.slice(at).match(/```js\s*\n([\s\S]*?)\n```/);
      if(!match)throw new Error('Reference code missing.');
      return match[1];
    }
    send(res,200,{helpers:block('H HELPER LIBRARY'),reference:block('REFERENCE STYLE SOURCE')});
  } catch(error) {fail(res,error)}
};
