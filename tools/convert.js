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

const targetDir = Path.resolve("flat_node_modules");

function moveThisModule(dir) {
  const pkgFile = Path.join(dir, "package.json");
  const pkg = require(pkgFile);
  const version = "v" + pkg.version;
  const targetNmDir = Path.join(targetDir, pkg.name, version, pkg.name);

  if (!Fs.existsSync(targetNmDir)) {
    if (!versionsMap.has(pkg.name)) {
      versionsMap.set(pkg.name, [pkg.version]);
    } else {
      versionsMap.get(pkg.name).push(pkg.version);
    }
    console.log(`moving ${dir} to ${targetNmDir}`);
    shell.mkdir("-p", targetNmDir);
    const files = Fs.readdirSync(Path.join(dir)).map((x) => Path.join(dir, x));
    shell.mv(files, targetNmDir);
    Fs.rmdirSync(dir);
  } else {
    shell.rm("-rf", dir);
  }
}

/*
 * Recursively go down node_modules until there's no more
 * Then move the module to <root>/node_modules/<version> if it doesn't exist
 * else just delete it from disk
 *
 */

function moveModules(dir) {
  const dirNm = Path.join(dir, "node_modules");
  if (Fs.existsSync(dirNm)) {
    moveModules(dirNm);
    shell.rm("-rf", Path.join(dirNm, ".bin"));
    Fs.rmdirSync(dirNm);
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
  const modules = Fs.readdirSync(Path.resolve("node_modules")).filter((x) => x !== ".bin" && !x.startsWith("__dep"));
  modules.forEach((m) => {
    versionsMap.set(m, Fs.readdirSync(Path.resolve("node_modules", m)));
  });
}

function moveModulesToFlat() {

  if (Fs.existsSync(Path.resolve("node_modules", "__dep_resolutions.json"))) {
    console.log("already flat");
    readVersions();
    sortVersionMaps();
    return;
  }

  moveModules(Path.resolve("node_modules"));

  shell.mv(Path.resolve("flat_node_modules", "*"), Path.resolve("node_modules"));
  Fs.rmdirSync(Path.resolve("flat_node_modules"));
}

let appDepRes = {};

function captureAppDepResolutions() {
  const appDepResFile = Path.resolve("node_modules", "__dep_resolutions.json");
  if (Fs.existsSync(appDepResFile)) {
    appDepRes = require(appDepResFile);
    Object.keys(appDepRes).forEach((m) => {
      if (appDepRes[m].resolved.startsWith("v")) {
        appDepRes[m].resolved = appDepRes[m].resolved.substr(1);
      }
    });
  }
  const topLevelModules = Fs.readdirSync(Path.resolve("node_modules")).filter((x) => x !== ".bin");
  topLevelModules.forEach((m) => {
    const mDir = Path.resolve("node_modules", m);
    const pkgFile = Path.join(mDir, "package.json");
    if (Fs.existsSync(pkgFile)) {
      const pkg = require(pkgFile);
      appDepRes[pkg.name] = {resolved: pkg.version};
    }
  });
}

function makeAppDepResolutions() {
  const appPkg = require(Path.resolve("package.json"));
  const appRes = makeDepResolutions(appPkg, true, appDepRes);
  Fs.writeFileSync(Path.resolve("node_modules", "__dep_resolutions.json"), JSON.stringify(appRes, null, 2));
}

function makeDepDepResolutions() {
  const modules = Fs.readdirSync(Path.resolve("node_modules")).filter((x) => x !== ".bin" && !x.startsWith("__dep"));
  modules.forEach((m) => {
    versionsMap.get(m).forEach((v) => {
      const mDir = Path.resolve("node_modules", m, v, m);
      const pkgFile = Path.join(mDir, "package.json");
      const pkg = require(pkgFile);
      pkg._depResolutions = makeDepResolutions(pkg, false);
      Fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    });
  });
}

function relinkBin(dir, depRes) {
  const binDir = Path.join(dir, ".bin");
  const links = Fs.readdirSync(binDir);
  const cwd = process.cwd();
  process.chdir(binDir);
  links.forEach((link) => {
    const linkFp = Path.join(binDir, link);
    const target = Fs.readlinkSync(linkFp);
    const splits = target.split("/");
    const modName = splits[1];
    let resolved;
    let res = depRes[modName];

    if (res) {
      resolved = res.resolved;
    } else {
      resolved = versionsMap.get(modName)[0];
    }

    if (!resolved.startsWith("v")) {
      resolved = "v" + resolved;
    }

    console.log("link", link, "target", target, splits);
    let newSplits = splits.slice(2);
    newSplits.unshift("..", modName, resolved, modName);
    const newTarget = Path.join.apply(Path, newSplits);
    const newTargetFp = Path.join(binDir, newTarget);
    console.log("link", link, "target", target, "new target", newTarget, newTargetFp);
    if (!Fs.existsSync(newTargetFp)) {
      console.log("newTarget", newTarget, "doesn't exist");
    } else {
      Fs.unlinkSync(linkFp);
      Fs.symlinkSync(newTarget, link);
    }
  });
}

captureAppDepResolutions();
moveModulesToFlat();
makeAppDepResolutions();
makeDepDepResolutions();
relinkBin(Path.resolve("node_modules"), require(Path.resolve("node_modules", "__dep_resolutions.json")));
