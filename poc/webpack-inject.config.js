  const path = require('path');
  const { CleanWebpackPlugin } = require('clean-webpack-plugin');

  module.exports = {
    mode: 'production',
    entry: {
      'inject-minimal': './src/index-inject.js',
    },
    plugins: [
      new CleanWebpackPlugin(),
    ],
    output: {
      filename: '[name].bundle.js',
      path: path.resolve(__dirname, 'dist-inject'),
    },
  };
