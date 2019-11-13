const webpack = require('webpack');
const middleware = require('webpack-dev-middleware');

const webpackConfig = require('./webpack.config.js');
const compiler = webpack(webpackConfig);
const express = require('express');
const app = express();

app.use(
  middleware(compiler, {
    publicPath: webpackConfig.output.publicPath
  }),
  express.static('static'),
);

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`Helper app listening on port ${PORT}!`);
  console.log('Bookmarklet:');
  console.log(`javascript:(function (){document.getElementsByTagName('head')[0].appendChild(document.createElement('script')).src='http://localhost:${PORT}/inject.bundle.js';}());`)
});
