/*
 * - Converts a node_modules installed by a normal package manager to the Flat node_modules
 * - Copies flat-module.js to your project root
 *
 */

"use strict";

const Path = require("path");
const Fs = require("fs");
const shell = require("shelljs");
const semver = require("semver");
const semverSort = require("semver-sort");

const versionsMap = new Map();
const flatVDir = "__fv_";

const sourceDir = Path.resolve("node_modules");
const targetDir = Path.resolve("flat_node_modules");

function moveThisModule(dir) {
  const pkgFile = Path.join(dir, "package.json");
  const pkg = require(pkgFile);
  const version = pkg.version;
  const targetNmDir = Path.join(targetDir, pkg.name, flatVDir, version, pkg.name);
  const targetDefault = Path.join(targetDir, pkg.name);
  const targetPkgFile = Path.join(targetDefault, "package.json");

  let targetPkg = {};
  if (Fs.existsSync(targetPkgFile)) {
    targetPkg = require(targetPkgFile);
  }
  if (!Fs.existsSync(targetNmDir) && targetPkg.version !== pkg.version) {
    if (!versionsMap.has(pkg.name)) {
      versionsMap.set(pkg.name, [pkg.version]);
    } else {
      versionsMap.get(pkg.name).push(pkg.version);
    }
    console.log(`copying ${dir} to ${targetNmDir}`);
    shell.mkdir("-p", targetNmDir);
    const files = Fs.readdirSync(Path.join(dir)).filter((x) => x !== "node_modules").map((x) => Path.join(dir, x));
    shell.cp("-Rf", files, targetNmDir);
  }
}

/*
 * Recursively go down node_modules until there's no more
 * Then move the module to <root>/node_modules/<mod_name>/__fv_/<version>/<mod_name>
 * if it doesn't exist else just delete it from disk
 *
 */

function moveModules(dir) {
  const dirNm = Path.join(dir, "node_modules");
  if (Fs.existsSync(dirNm)) {
    moveModules(dirNm);
  }
  const pkgFile = Path.join(dir, "package.json");
  if (Fs.existsSync(pkgFile)) {
    moveThisModule(dir);
  } else {
    const modules = Fs.readdirSync(dir).filter((x) => x !== ".bin");
    modules.forEach((m) => {
      moveModules(Path.join(dir, m));
    });
  }
}

function resolveResolutions(depRes, pkg, section, deps) {
  if (!deps) {
    return;
  }
  if (depRes[pkg.name]) {
    return;
  }
  Object.keys(deps).forEach((modName) => {
    if (!versionsMap.has(modName)) {
      console.log("Unable to find versions for", modName, "in section", section);
      return;
    }
    const sv = deps[modName];
    const versions = versionsMap.get(modName);
    let resolved = versions.find((v) => semver.satisfies(v, sv));
    if (!resolved) {
      console.log(pkg.name, "can't find resolved for", modName, "using latest");
      resolved = versions[0];
    }
    if (resolved.startsWith("v")) {
      resolved = resolved.substr(1);
    }
    depRes[modName] = {
      resolved,
      [section]: true
    };
  });
}

function makeDepResolutions(pkg, dev, depRes) {
  depRes = depRes || {};
  resolveResolutions(depRes, pkg, "prod", pkg.dependencies);
  dev && resolveResolutions(depRes, pkg, "dev", pkg.devDependencies);
  resolveResolutions(depRes, pkg, "peer", pkg.peerDependencies);
  return depRes;
}

function sortVersionMaps() {
  versionsMap.forEach((v) => {
    semverSort.desc(v);
  });
}

function readVersions() {
  if (!Fs.existsSync(targetDir)) {
    return;
  }
  const modules = Fs.readdirSync(targetDir).filter((x) => x !== ".bin" && !x.startsWith("__dep"));
  modules.forEach((m) => {
    const vDir = Path.resolve(targetDir, m, flatVDir);
    if (Fs.existsSync(vDir)) {
      versionsMap.set(m, Fs.readdirSync(vDir));
    } else {
      versionsMap.set(m, [require(Path.resolve(targetDir, m, "package.json"))._flatVersion]);
    }
  });
}

function moveModulesToFlat() {

  if (Fs.existsSync(Path.resolve(targetDir, "__dep_resolutions.json"))) {
    console.log("already flat");
    readVersions();
    sortVersionMaps();
    return;
  }

  moveModules(sourceDir);
}

let appDepRes = {};

function captureAppDepResolutions() {
  const appDepResFile = Path.resolve(targetDir, "__dep_resolutions.json");
  if (Fs.existsSync(appDepResFile)) {
    appDepRes = require(appDepResFile);
  }
  const topLevelModules = Fs.readdirSync(sourceDir).filter((x) => x !== ".bin");
  topLevelModules.forEach((m) => {
    const mDir = Path.resolve(sourceDir, m);
    const pkgFile = Path.join(mDir, "package.json");
    if (Fs.existsSync(pkgFile)) {
      const pkg = require(pkgFile);
      console.log("capture top module", pkg.name, "resolved version", pkg.version);
      appDepRes[pkg.name] = { resolved: pkg.version };
    }
  });
}

function makeAppDepResolutions() {
  const appPkg = require(Path.resolve("package.json"));
  const appRes = makeDepResolutions(appPkg, true, appDepRes);
  Fs.writeFileSync(Path.resolve(targetDir, "__dep_resolutions.json"), JSON.stringify(appRes, null, 2));
}

function makeDepDepResolutions() {
  const modules = Fs.readdirSync(targetDir).filter((x) => x !== ".bin" && !x.startsWith("__dep"));
  modules.forEach((m) => {
    versionsMap.get(m).forEach((v) => {
      const mDir = Path.resolve(targetDir, m, flatVDir, v, m);
      if (Fs.existsSync(mDir)) {
        const pkgFile = Path.join(mDir, "package.json");
        const pkg = require(pkgFile);
        pkg._depResolutions = makeDepResolutions(pkg, false);
        Fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      }
    });
  });
}

function relinkBin(dir, depRes) {
  const binDir = Path.join(sourceDir, ".bin");
  const targetBinDir = Path.join(targetDir, ".bin");
  shell.mkdir("-p", targetBinDir);
  const links = Fs.readdirSync(binDir);
  const cwd = process.cwd();
  process.chdir(targetBinDir);
  links.forEach((link) => {
    const linkFp = Path.join(binDir, link);
    const target = Fs.readlinkSync(linkFp);
    const splits = target.split("/");
    const modName = splits[1];
    let res = depRes[modName];

    let newSplits = splits.slice(2);
    const versions = versionsMap.get(modName);

    /* has a resolved version that's been promoted to default or there's only a single version */
    if (res || versions.length === 1) {
      newSplits.unshift("..", modName);
    } else {
      /* no resolved, then just link to first version */
      /* this scenario should not be possible */
      console.log("!!!!! No app resolved version captured for module", modName);
      newSplits.unshift("..", modName, flatVDir, versions[0], modName);
    }

    const newTarget = Path.join.apply(Path, newSplits);
    const newTargetFp = Path.join(targetBinDir, newTarget);
    console.log("link", link, "target", target, "new target", newTarget, newTargetFp);
    if (!Fs.existsSync(newTargetFp)) {
      console.log("newTarget", newTarget, "doesn't exist");
    } else {
      if (Fs.existsSync(link)) {
        Fs.unlinkSync(link);
      }
      Fs.symlinkSync(newTarget, link);
    }
  });
  process.chdir(cwd);
}


function promoteDefaults(dir) {
  const promoteVersionToDefault = (version, modName) => {
    const vDir = Path.join(dir, modName, flatVDir, version, modName);
    if (Fs.existsSync(vDir)) {
      console.log("Promoting module", modName + "@" + version, "to default");
      const files = Fs.readdirSync(vDir).map((x) => Path.join(vDir, x));
      shell.mv(files, Path.join(dir, modName));
      const pkgFile = Path.join(dir, modName, "package.json");
      const pkg = require(pkgFile);
      pkg._flatVersion = version;
      Fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      Fs.rmdirSync(vDir);
      Fs.rmdirSync(Path.join(vDir, ".."));
      return true;
    }
    return false;
  };

  versionsMap.forEach((versions, modName) => {
    const res = appDepRes[modName];
    /* promote the app resolved or latest version to default - expected versions sorted desc */
    const promote = res ? res.resolved : versions[0];
    if (promoteVersionToDefault(promote, modName)) {
      /* only version has been promoted, no need to keep the __fv_ dir anymore */
      if (versions.length === 1) {
        shell.rm("-rf", Path.join(dir, modName, flatVDir));
      }
    }
  });
}

captureAppDepResolutions();
moveModulesToFlat();
makeAppDepResolutions();
makeDepDepResolutions();
promoteDefaults(targetDir);
relinkBin(targetDir, require(Path.resolve(targetDir, "__dep_resolutions.json")));
shell.cp("-f", Path.join(__dirname, "../flat-module.js"), process.cwd());
