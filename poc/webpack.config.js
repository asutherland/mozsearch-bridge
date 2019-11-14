  const path = require('path');
  const { CleanWebpackPlugin } = require('clean-webpack-plugin');

  module.exports = {
    mode: 'development',
    entry: {
      // core infrastructure
      bridge: './src/index-bridge.js',
      inject: './src/index-inject.js',
      // various app things
      simple: './src/index-simple.js',
    },
    devtool: 'inline-source-map',
    plugins: [
      new CleanWebpackPlugin(),
    ],
    output: {
      filename: '[name].bundle.js',
      path: path.resolve(__dirname, 'dist'),
    },
  };
