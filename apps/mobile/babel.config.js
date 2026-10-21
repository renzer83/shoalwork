module.exports = (api) => {
  api.cache(true)
  return {
    presets: ["babel-preset-expo"],
    // Must stay last: the worklets plugin rewrites functions after every other transform ran.
    plugins: ["react-native-worklets/plugin"],
  }
}
