  const path = require('path');
  const { CleanWebpackPlugin } = require('clean-webpack-plugin');
  const CopyPlugin = require("copy-webpack-plugin");

  module.exports = {
    mode: 'development',
    entry: {
      // ## core infrastructure
      bridge: './src/index-bridge.js',
      inject: './src/index-inject.js',

      // ## bookmarklet making support
      bookmarklet: './src/bookmarklet-maker.js',
      // various app things
      simple: './src/index-simple.js',
    },
    devtool: 'inline-source-map',
    plugins: [
      new CleanWebpackPlugin(),
      new CopyPlugin({
        patterns: [
          { from: "node_modules/@hpcc-js/wasm/dist/index.min.js" },
          { from: "node_modules/@hpcc-js/wasm/dist/index.min.js.map" },
          { from: "node_modules/@hpcc-js/wasm/dist/graphvizlib.wasm" },
        ],
      }),
    ],
    output: {
      filename: '[name].bundle.js',
      path: path.resolve(__dirname, 'dist'),
    },
  };
