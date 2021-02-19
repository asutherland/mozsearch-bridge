import parse from '@iarna/toml/parse-string';

class AnalyzerConfig {
  constructor(rawConfig) {
    this.rawConfig = rawConfig;

    this.tomlConfig = parse(rawConfig);
  }
}

class Analyzer {
  constructor(config) {
    this.config = config;

    this.client = null;
    this.allResults = [];
  }

  async analyze(client, progressCallback) {
    console.log('Analyzing using config', this.config);
    const tomlConfig = this.config.tomlConfig;

    this.client = client;
    const allResults = this.allResults = [];

    console.log("traversing", tomlConfig.trace);
    for (const [symName, info] of Object.entries(tomlConfig.trace)) {
      console.log('Tracing', symName, info);
      progressCallback(`Tracing ${symName}`, {});
      await this._doTrace(symName, info || {});
    }

    progressCallback('Done', {});

    console.log('Results', allResults);
    return allResults;
  }

  _lookupClassInfoFromSymbol(symName) {
    const tomlConfig = this.config.tomlConfig;
    if (!tomlConfig['class']) {
      return null;
    }

    const idxDouble = symName.lastIndexOf('::');
    if (idxDouble === -1) {
      return null;
    }
    const className = symName.substring(0, idxDouble);
    const classInfo = this.config.tomlConfig['class'][className];
    return classInfo || null;
  }

  async _doTrace(symName, info) {
    const classInfo = this._lookupClassInfoFromSymbol(symName);
    let printParts =
      (info.capture || (classInfo && classInfo.state)) ? [] : undefined;

    if (info.capture) {
      for (const captureParam of info.capture) {
        // Currently we imitate tricelog which wants the parameters separated,
        // but there can be 2 types of traversal, so we're also allowing
        // single-argument full traversals... but let's join things the likely
        // way for multi-arg.
        printParts.push(captureParam.join('->'));
      }
    }
    if (classInfo && classInfo.state) {
      for (const stateParam of classInfo.state) {
        printParts.push(`this->${stateParam.join('->')}`);
      }
    }

    const print = printParts ? printParts.join(', ') : undefined;

    // This will be an array of items of the form { items: [ { focus, pml }]}
    const rawResults = await this.client.sendMessageAwaitingReply(
      'executionQuery',
      { symbol: symName, print });

    this.allResults.push(...rawResults);
  }
}

export async function loadAnalyzer(path) {
  const resp = await fetch(path);
  const respText = await resp.text();

  const config = new AnalyzerConfig(respText);
  return new Analyzer(config);
}
