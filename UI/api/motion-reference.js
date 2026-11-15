// Returns user-provided reference drawing code for an isolated, local-only style preview.
const {HttpError, send, fail} = require('./_lib');
const {assertLocal, readJson} = require('./_motion-provider');
const {STYLE_FILES} = require('./motion');
const fs = require('fs');
const path = require('path');
module.exports = async (req, res) => {
  try {
    assertLocal(req);
    const data = await readJson(req, 4096);
    if (!Object.hasOwn(STYLE_FILES,data.style)) throw new HttpError(400,'Unknown video style.');
    const source=fs.readFileSync(path.join(__dirname,'_motion-styles',STYLE_FILES[data.style].file),'utf8');
    function block(header) {
      const at=source.indexOf(header); if(at<0)throw new Error('Reference section missing.');
      const match=source.slice(at).match(/```js\s*\n([\s\S]*?)\n```/);
      if(!match)throw new Error('Reference code missing.');
      return match[1];
    }
    send(res,200,{helpers:block('H HELPER LIBRARY'),reference:block('REFERENCE STYLE SOURCE')});
  } catch(error) {fail(res,error)}
};
