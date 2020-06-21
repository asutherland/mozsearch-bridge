const webpack = require('webpack');
const middleware = require('webpack-dev-middleware');

const webpackConfig = require('./webpack.config.js');
const injectConfig = require('./webpack-inject.config.js');
const compiler = webpack(webpackConfig);
const injectCompiler = webpack(injectConfig);
const express = require('express');
//const cors = require('cors');
const app = express();

//app.use(cors());
app.use(
  middleware(injectCompiler, {
    publicPath: injectConfig.output.publicPath,
  }),
  middleware(compiler, {
    publicPath: webpackConfig.output.publicPath
  }),
  express.static('static'),
);

const PORT = 3333;

// ### Various CSP Fun (going to remove after committing)

function bookmarkletFromCode(str) {
  // IIFE construct, str needs to contain a function
  return 'javascript:(' + str.replace(/\n */g, '') + '())';
}

// If we don't care about CSP, we can just insert a script tag.  But there's no
// magic tainting for our CSP-bypassing privileged evaluation to propagate to
// the script tag.
const cspDisabledFunc = `function () {
  document.getElementsByTagName('head')[0].appendChild(document.createElement('script')).src='http://localhost:${PORT}/inject.bundle.js';
}`;

// In order to bypass CSP, we need to evalute the "inject.bundle.js" script in
// the scope of the target.  Unfortunately, while the "javascript" protocol lets
// us bypass the restriction that arbitrary evaluation shouldn't be possible,
// we don't end up running in a magical sandbox with a means of bypassing the
// checks that fetch and XHR will perform for "connect-src".

// sandbox in which this code executes.  Which means we need to fetch the
// underlying script and `eval` it ourself.  However,
const cspNOkayFunc = `async function() {
  const resp = await fetch('http://localhost:${PORT}/inject.bundle.js');
  const text = await resp.text();
  eval(text);
}`;

const cspOkayFunc = `function() {
  const req = new XMLHttpRequest();
  req.open('GET', 'http://localhost:${PORT}/inject.bundle.js', false);
  req.send(null);
  eval(req.responseText);
}`;

app.listen(PORT, () => {
  console.log(`Helper app listening on port ${PORT}!`);
  console.log('You need to use a browser instance with CSP disabled for now.');
  console.log('');
  console.log('Bookmarklet that bootstraps with devtools:');
  console.log(`javascript:(function (){document.getElementsByTagName('head')[0].appendChild(document.createElement('script')).src='http://localhost:${PORT}/inject.bundle.js';}());`)
  console.log('');
  console.log(`Production bookmarklet maker: http://localhost:${PORT}/bookmarklet.html`);
  console.log('(Which still will fail to run thanks to CSP.)');
});
