'use strict';

const Module = require("module");
const fs = require("fs");
const assert = require("assert");
const path = require("path");

assert(!Module._flat_orig_resolveLookupPaths, "Flat Module system already installed");

Module._flat_orig_resolveLookupPaths = Module._resolveLookupPaths;
Module._flat_orig_findPath = Module._findPath;

const linkedMap = new Map();
const topDirMap = new Map();
const flatFlagMap = new Map();
const versionsMap = new Map();

const debug = Module._debug;
const nodeModules = "node_modules";
const packageJson = "package.json";

let internals = {};

// vvv copied from https://github.com/domenic/path-is-inside/blob/master/lib/path-is-inside.js

function pathIsInside(thePath, potentialParent) {
  // For inside-directory checking, we want to allow trailing slashes, so normalize.
  thePath = stripTrailingSep(thePath);
  potentialParent = stripTrailingSep(potentialParent);

  // Node treats only Windows as case-insensitive in its path module; we follow those conventions.
  /* istanbul ignore next */
  if (process.platform === "win32") {
    thePath = thePath.toLowerCase();
    potentialParent = potentialParent.toLowerCase();
  }

  return thePath.lastIndexOf(potentialParent, 0) === 0 &&
    (
      thePath[potentialParent.length] === path.sep ||
      thePath[potentialParent.length] === undefined
    );
}

function stripTrailingSep(thePath) {
  /* istanbul ignore next */
  if (thePath[thePath.length - 1] === path.sep) {
    return thePath.slice(0, -1);
  }
  return thePath;
}

// ^^^ https://github.com/domenic/path-is-inside/blob/master/lib/path-is-inside.js

internals.getLinkedInfo = (nmDir) => {
  const linkedF = path.join(nmDir, "__linked_from.json");
  if (fs.existsSync(linkedF)) {
    const linked = JSON.parse(fs.readFileSync(linkedF));
    return linked[process.cwd()];
  }
  return false;
};

//
// There is only one node_modules rather than many nested ones.
// Set dir with node_modules as topDir.
//
// - directory of require origin <doro>
// -- parent.filename or CWD if it's is null.
//
// - To find topDir from <doro>:
//
// -- If <doro> is under CWD:
// ---- if <doro>/node_modules exist, then use <doro>.
// ---- if <doro> contains node_modules, then use up to the last node_modules.
// ---- finally search for existence of node_modules up to root.
// -- If <doro> is not under CWD (installations outside of CWD), then
// check for first node_modules up to root.
//
// There are two scenarios when <doro> is not under CWD.
//
// ** It could be a globally installed CLI program and whatever it is, it has no
// access to node_modules under CWD so must resolves its dependencies in its
// own node_modules.
//
// ** It could be a linked module.
// we could do what's always been done - force linked modules to have their
// own dependencies, or handle this in the module system.  So under its own
// node_modules directory, have a __linked_from.json with a list
// of directories for apps that have linked to it.  When that file is detected
// and CWD is listed in it, then switch to looking in CWD for node_modules.
//
// linked module should:
//   - has all its dependencies installed in host's node_modules
//   - has a __linked_from.json in its own node_modules
//   - (optionally) has its own __dep_resolutions.json, use when being developed itself
//
// If a module is not installed by semver, then its resolve version is:
//
// symlink: v_symlink_<base64 of target full path md5>
// file: v_file_<base64 of full file path md5>
// git/url: v_<type>url_<base64 of URL md5>
//
//
// A package manager should:
//   - save _depResolutions in an installed module's package.json.
//   - create __dep_resolutions.json under CWD/node_modules
//
// _depResolutions should contain the exact version that was resolved
// for the given module's dependencies semver
//

//
// search from originDir up to CWD or / looking for the first node_modules
// and use that as topDir
//
internals.searchTopDir = (originDir) => {
  let dir;
  let up = originDir;
  let linkedInfo;
  const cwd = process.cwd();
  while (up) {
    originDir = up;
    const nmDir = path.join(originDir, nodeModules);
    if (fs.existsSync(nmDir)) {
      dir = originDir; // yay, found node_modules
      // but is it a linked module?
      const cacheKey = cwd + ":" + nmDir;
      if (!linkedMap.has(cacheKey)) {
        linkedMap.set(cacheKey, internals.getLinkedInfo(nmDir));
      }
      linkedInfo = linkedMap.get(cacheKey);
      if (linkedInfo) {
        dir = cwd; // switch to looking in CWD for linked mod
      }
      break;
    }
    up = path.join(originDir, "..");
    if (originDir === up) {
      break;
    }
  }

  return {dir, linkedInfo};
};

// search from <dir> up to <stopDir> or / for the file package.json
internals.findNearestPackage = (dir, stopDir, singleStops) => {
  let up = dir;
  while (up) {
    dir = up;
    const pkgFile = path.join(dir, packageJson);
    if (fs.existsSync(pkgFile)) {
      return require(pkgFile);
    }
    if (dir === stopDir ||
      (singleStops && singleStops.indexOf(path.basename(dir)) >= 0)) {
      break;
    }
    up = path.join(dir, "..");
    if (dir === up) {
      break;
    }
  }
};

//
// find module name by matching dir name to request under <dir>/node_modules
//
internals.findModuleName = (dir, request) => {
  const splits = request.split("/");
  if (splits.length < 2) {
    return request;
  }
  dir = path.join(dir, nodeModules);
  for (let i = 0; i < splits.length; i++) {
    dir = path.join(dir, splits[i]);
    if (!fs.existsSync(dir)) {
      return splits.slice(0, i).join("/");
    }
  }
  return request;
};

internals.isRelativePathRequest = (request) => {
  if (request === "." || request === "..") {
    return true;
  }

  if (request.startsWith("../") || request.startsWith("./")) {
    return true;
  }

  /* istanbul ignore next */
  if (path.sep !== "/") {
    return request.startsWith("." + path.sep) || request.startsWith(".." + path.sep);
  }

  return false;
};

internals.useOriginalLookup = (request) => {
  return path.isAbsolute(request) || internals.isRelativePathRequest(request);
};

internals.parseRequest = (request) => {
  let semVer = "";
  const xAt = request.indexOf("@");
  if (xAt > 0) {
    const tmp = request.substr(0, xAt);
    const xSep = request.indexOf("/", xAt);
    let tail = "";

    if (xSep > xAt) {
      tail = request.substr(xSep);
      semVer = request.substring(xAt + 1, xSep);
    } else {
      semVer = request.substr(xAt + 1);
    }
    request = tmp + tail;
  }
  return {request, semVer}
};

// from https://github.com/sindresorhus/semver-regex/blob/master/index.js
const semVerRegex = /\bv?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z\-]+(?:\.[\da-z\-]+)*)?(?:\+[\da-z\-]+(?:\.[\da-z\-]+)*)?\b/ig;

internals.semVerMatch = (semVer, ver) => {
  // support x.x.x format ONLY
  const isAny = (v) => {
    return !v || (v === "x" || v === "X" || v === "*");
  };

  if (isAny(semVer)) {
    return true;
  }

  const svSplits = semVer.split(".");
  const verSplits = ver.split(".");
  for (let i = 0; i < verSplits.length; i++) {
    if (i >= svSplits.length) {
      return true;
    } else if (!isAny(svSplits[i])) {
      if (svSplits[i] !== verSplits[i]) {
        return false;
      }
    }
  }

  return true;
};

internals.semVerCompare = (a, b) => {
  if (a === b) {
    return 0;
  }

  const mA = a.substr(1).match(semVerRegex);
  const mB = b.substr(1).match(semVerRegex);
  if (mA && mB) {
    const aSp = mA[0].split(".");
    const bSp = mB[0].split(".");
    for (let i = 0; i < aSp.length; i++) {
      const aN = parseInt(aSp[i], 10);
      const bN = parseInt(bSp[i], 10);
      if (aN > bN) {
        return 1;
      }
      if (aN < bN) {
        return -1;
      }
    }
    return 0;
  }

  return a > b ? 1 : -1;
};

internals.getModuleVersions = (modDir) => {
  if (!versionsMap.has(modDir) && fs.existsSync(modDir)) {
    versionsMap.set(modDir, fs.readdirSync(modDir).sort(internals.semVerCompare));
  }

  return versionsMap.get(modDir);
};


function flatResolveLookupPaths(request, parent) {
  if (internals.useOriginalLookup(request)) {
    return this._flat_orig_resolveLookupPaths(request, parent);
  }

  const reqParts = internals.parseRequest(request);
  request = reqParts.request;

  debug(`flat _resolveLookupPaths: request ${request} parent.id ${parent && parent.id}`);

  const cwd = process.cwd();

  const findTopDir = (originDir) => {
    // if parentDir is under CWD, look for node_modules
    if (pathIsInside(originDir, cwd)) {
      if (fs.existsSync(path.join(originDir, nodeModules))) {
        return {dir: originDir};
      } else {
        const nmIndex = originDir.lastIndexOf(path.sep + nodeModules);
        if (nmIndex >= 0) {
          return {dir: path.join(originDir.substr(0, nmIndex + nodeModules.length + 1), "..")};
        }
      }
    }
    // can't use CWD as topDir?
    // search up for node_modules
    return internals.searchTopDir(originDir);
  };

  const getTopDir = (originDir) => {
    if (topDirMap.has(originDir)) {
      return topDirMap.get(originDir);
    } else {
      const td = findTopDir(originDir);
      topDirMap.set(originDir, td);
      return td;
    }
  };

  const parentDir = parent.filename && path.dirname(parent.filename);
  const originDir = parentDir || cwd;
  const topDir = getTopDir(originDir);
  let flatFlag = flatFlagMap.get(topDir.dir);

  if (flatFlag === false) {
    return this._flat_orig_resolveLookupPaths(request, parent);
  }

  // If can't figure out topDir, then give up.
  if (!topDir.dir) {
    return [request, []]; // force not found error out
  }

  //
  // Now we should've figured out where to find parent's dependencies.
  // Next resolve the version of the module to load.
  //

  const moduleName = internals.findModuleName(topDir.dir, request);

  let pkg = parent._package;

  if (!pkg) {
    //
    // search from parent's location up to topDir or / for package.json and load it
    // stopping if a directory named node_modules is seen since
    // that means what's being searched is an installed module and should have
    // a package.json found already.
    //
    pkg = internals.findNearestPackage(originDir, topDir.dir, [nodeModules]);
    if (pkg) {
      parent._package = pkg;
    }
  }

  // lookup specific version mapped for parent inside its nearest package.json
  const getDepResolutions = (topDir, pkg) => {
    if (!pkg) {
      return {};
    }

    //
    // common case - a package manager should've install a package with _depResolutions
    // saved in its package.json file.
    //
    if (pkg._depResolutions) {
      return pkg._depResolutions;
    }
    //
    // package.json doesn't have _depResolutions entry
    // is it linked module? Then look inside linked info
    //
    const linkedInfo = topDir.linkedInfo;
    if (linkedInfo && linkedInfo._depResolutions) {
      pkg._depResolutions = linkedInfo._depResolutions;
      debug(`Using linkedInfo._depResolutions for ${request}`);
      return linkedInfo._depResolutions;
    }

    //
    // is it topDir/package.json? Then look for topDir/node_modules/__dep_resolutions.json
    //
    const ff = path.join(topDir.dir, nodeModules, "__dep_resolutions.json");
    if (fs.existsSync(ff)) {
      pkg._depResolutions = require(ff);
    } else {
      //
      // can't find _depResolutions, fallback to original node module resolution.
      //
      assert(flatFlag === undefined,
        "flat module can't determine dep resolution but flat mode is already " + flatFlag);
      flatFlag = false;
      flatFlagMap.set(topDir.dir, flatFlag);
      return {};
    }

    return pkg._depResolutions;
  };

  const getResolvedVersion = () => {
    const depRes = getDepResolutions(topDir, pkg);
    const r = depRes[moduleName];
    return r && r.resolved;
  };

  const getVersion = (semVer, modDir) => {
    if (semVer) {
      const versions = internals.getModuleVersions(modDir)
        .map((x) => x.substr(1)) // sort and remove leading 'v'
        .filter((v) => internals.semVerMatch(semVer, v));
      return versions.length > 0 && versions[versions.length - 1];
    } else {
      return getResolvedVersion();
    }
  };

  const moduleDir = path.join(topDir.dir, nodeModules, moduleName);
  const version = getVersion(reqParts.semVer, moduleDir);

  //
  // unable to resolve a version for a dependency, error out
  //
  if (!version) {
    if (flatFlag === false) {
      return this._flat_orig_resolveLookupPaths(request, parent);
    }
    return [request, []]; // force not found error out
  }

  if (flatFlag === undefined) {
    flatFlagMap.set(topDir.dir, true);
  }

  return [request, [path.join(moduleDir, version.startsWith("v") ? version : "v" + version)]];
}

function flatFindPath(request, paths, isMain) {
  if (!internals.useOriginalLookup(request)) {
    request = internals.parseRequest(request).request;
  }

  return this._flat_orig_findPath(request, paths, isMain);
}

Module._resolveLookupPaths = flatResolveLookupPaths;
Module._findPath = flatFindPath;

module.exports = {
  flatResolveLookupPaths,
  restore: () => {
    Module._resolveLookupPaths = Module._flat_orig_resolveLookupPaths;
    delete Module._flat_orig_resolveLookupPaths
  },
  internals
};
