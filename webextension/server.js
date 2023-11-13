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
