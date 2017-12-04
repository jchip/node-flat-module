"use strict";

const Module = require("module");
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const ORIG_RESOLVE_LOOKUP_PATHS = Symbol("ORIG_RESOLVE_LOOKUP_PATHS");
const ORIG_FIND_PATH = Symbol("ORIG_FIND_PATH");

assert(!Module[ORIG_RESOLVE_LOOKUP_PATHS], "Flat Module system already installed");

Module[ORIG_RESOLVE_LOOKUP_PATHS] = Module._resolveLookupPaths;
Module[ORIG_FIND_PATH] = Module._findPath;

const linkedMap = new Map();
const topDirMap = new Map();
const flatFlagMap = new Map();
const versionsMap = new Map();
const pkgDataMap = new Map();
const versionsDir = "__fv_";

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

  return (
    thePath.lastIndexOf(potentialParent, 0) === 0 &&
    (thePath[potentialParent.length] === path.sep || thePath[potentialParent.length] === undefined)
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

internals.getLinkedInfo = nmDir => {
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
// search from <dir> up to <stopDir> or /, or checkCb returns non-undefined
//
internals.searchUpDir = (dir, stopDir, singleStops, checkCb) => {
  let up = dir;
  while (up) {
    dir = up;
    const result = checkCb(dir);
    if (result !== undefined) return result;

    if (
      (stopDir && dir === stopDir) ||
      (singleStops && singleStops.indexOf(path.basename(dir)) >= 0)
    ) {
      break;
    }

    up = path.join(dir, "..");
    if (dir === up) {
      break;
    }
  }

  return false;
};

//
// search from originDir up to CWD or / looking for the first node_modules
// and use that as topDir
//
internals.searchTopDir = originDir => {
  let dir;
  let linkedInfo;

  const cwd = process.cwd();

  internals.searchUpDir(originDir, null, null, x => {
    const nmDir = path.join(x, nodeModules);
    if (fs.existsSync(nmDir)) {
      dir = x; // yay, found node_modules
      // but is it a linked module?
      const cacheKey = cwd + ":" + nmDir;
      if (!linkedMap.has(cacheKey)) {
        linkedMap.set(cacheKey, internals.getLinkedInfo(nmDir));
      }
      linkedInfo = linkedMap.get(cacheKey);
      if (linkedInfo) {
        dir = cwd; // switch to looking in CWD for linked mod
      }
      return true;
    }
    return undefined;
  });

  return { dir, linkedInfo };
};

internals.readJSON = f => {
  return JSON.parse(fs.readFileSync(f));
};

internals.readPackage = dir => {
  if (pkgDataMap.has(dir)) return pkgDataMap.get(dir);
  const pkgFile = path.join(dir, packageJson);
  if (!fs.existsSync(pkgFile)) return false;

  const pkg = internals.readJSON(pkgFile);

  const x = {
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies,
    bundledDependencies: pkg.bundledDependencies || pkg.bundleDependencies,
    _flatVersion: pkg._flatVersion,
    _depResolutions: pkg._depResolutions
  };

  pkgDataMap.set(dir, x);

  return x;
};

internals.findMappedPackage = (dir, stopDir, singleStops) => {
  return internals.searchUpDir(dir, stopDir, singleStops, x => {
    return pkgDataMap.has(dir) ? pkgDataMap.get(dir) : undefined;
  });
};

// search from <dir> up to <stopDir> or / for the file package.json
internals.findNearestPackage = (dir, stopDir, singleStops) => {
  const mappedPkg = internals.findMappedPackage(dir, stopDir, singleStops);
  if (mappedPkg) return mappedPkg;

  return internals.searchUpDir(dir, stopDir, singleStops, x => {
    const pkg = internals.readPackage(x);
    return pkg || undefined;
  });
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

  const hasVersionsDir = d => fs.existsSync(path.join(d, versionsDir));
  const hasPkgJson = d => fs.existsSync(path.join(d, "package.json"));

  let i;
  for (i = 0; i < splits.length; i++) {
    dir = path.join(dir, splits[i]);
    if (hasVersionsDir(dir) || hasPkgJson(dir)) {
      request = splits.slice(0, i + 1).join("/");
      break;
    }
  }
  return request;
};

internals.isRelativePathRequest = request => {
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

internals.useOriginalLookup = (request, parent) => {
  if (request === "<repl>") return true;
  if (path.isAbsolute(request) || internals.isRelativePathRequest(request)) return true;
  // if origin contains two or more node_modules then let original module system handle it
  const x = (parent && parent.filename && parent.filename.indexOf(nodeModules)) || -1;
  return x >= 0 && parent.filename.indexOf(nodeModules, x + 1) > x;
};

internals.parseRequest = request => {
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
  return { request, semVer };
};

// from https://github.com/sindresorhus/semver-regex/blob/master/index.js
const semVerRegex = /\bv?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z\-]+(?:\.[\da-z\-]+)*)?(?:\+[\da-z\-]+(?:\.[\da-z\-]+)*)?\b/gi;

internals.semVerMatch = (semVer, ver) => {
  // support x.x.x format ONLY
  const isAny = v => {
    return !v || (v === "x" || v === "X" || v === "*");
  };

  if (isAny(semVer)) {
    return true;
  }

  const svSplits = semVer.split(".");
  const verSplits = ver.split(".");
  let i;
  for (i = 0; i < verSplits.length; i++) {
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

  const mA = a.match(semVerRegex);
  const mB = b.match(semVerRegex);
  if (mA && mB) {
    const aSp = mA[0].split(".");
    const bSp = mB[0].split(".");
    let i;
    for (i = 0; i < aSp.length; i++) {
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

internals.getModuleVersions = (modName, modDir) => {
  debug("getModuleVersions", modName, modDir);

  if (!versionsMap.has(modDir) && fs.existsSync(modDir)) {
    const vDir = path.join(modDir, versionsDir);
    let versions = { all: !fs.existsSync(vDir) ? [] : fs.readdirSync(vDir) };

    //
    // does there exist a default version
    //
    const pkg = internals.readPackage(modDir);
    if (pkg) {
      if (versions.all.indexOf(pkg._flatVersion) < 0) {
        versions.all.push(pkg._flatVersion);
      }

      versions.default = pkg._flatVersion;
    }

    versions.all = versions.all.sort(internals.semVerCompare);
    versionsMap.set(modName, versions);
  }

  return versionsMap.get(modName);
};

const _PACKAGE = Symbol("_package");

function flatResolveLookupPaths(request, parent, newReturn) {
  if (internals.useOriginalLookup(request, parent)) {
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
  }

  const reqParts = internals.parseRequest(request);
  request = reqParts.request;

  debug(`flat _resolveLookupPaths: request ${request} parent.id ${parent && parent.id}`);

  const cwd = process.cwd();

  const findTopDir = originDir => {
    // if parentDir is under CWD, look for node_modules
    if (pathIsInside(originDir, cwd)) {
      // If there is node_modules right where request originated, then use it as topDir
      if (fs.existsSync(path.join(originDir, nodeModules))) {
        return { dir: originDir };
      } else {
        // TODO: check win32 if it's `\node_modules` or `/node_modules`
        // If the dir itself already has `/node_modules` then take the dir
        // one level up from where that occurred as topDir
        const nmIndex = originDir.lastIndexOf(path.sep + nodeModules);
        if (nmIndex >= 0) {
          return { dir: path.join(originDir.substr(0, nmIndex + nodeModules.length + 1), "..") };
        }
      }
    }

    // can't figure out topDir quickly, so have do dir search up for node_modules
    return internals.searchTopDir(originDir);
  };

  const getTopDir = originDir => {
    if (topDirMap.has(originDir)) {
      const d = topDirMap.get(originDir);
      debug("got topDir from map", d, originDir);
      return d;
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
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
  }

  // If can't figure out topDir, then give up.
  if (!topDir.dir) {
    /* istanbul ignore next */
    return newReturn ? null : [request, []]; // force not found error out
  }

  //
  // Now we should've figured out where to find parent's dependencies.
  // Next resolve the version of the module to load.
  //

  const moduleName = internals.findModuleName(topDir.dir, request);

  let pkg = parent[_PACKAGE];

  if (!pkg) {
    //
    // search from parent's location up to topDir or / for package.json and load it
    // stopping if a directory named node_modules is seen since
    // that means what's being searched is an installed module and should have
    // a package.json found already.
    //
    pkg = internals.findNearestPackage(originDir, topDir.dir, [nodeModules]);
    if (pkg) {
      parent[_PACKAGE] = pkg;
    }
  }

  //
  // Pkg has bundledDependencies: use original module system
  //
  if (pkg && pkg.bundledDependencies && pkg.bundledDependencies.indexOf(request) >= 0) {
    debug("has bundledDependencies", originDir, topDir.dir);
    flatFlagMap.set(topDir.dir, false);
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
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

    if (pkg._topDepRes) {
      return pkg._topDepRes;
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

    if (topDir.depRes) {
      return (pkg._topDepRes = topDir.depRes);
    } else {
      //
      // is it topDir/package.json? Then look for topDir/node_modules/__dep_resolutions.json
      //
      const ff = path.join(topDir.dir, nodeModules, "__dep_resolutions.json");
      if (fs.existsSync(ff)) {
        return (topDir.depRes = pkg._topDepRes = internals.readJSON(ff));
      }
    }

    //
    // can't find _depResolutions, fallback to original node module resolution.
    //
    assert(
      flatFlag === undefined,
      `${request} flat module can't determine dep resolution but flat mode is already ${flatFlag}`
    );
    flatFlag = false;
    flatFlagMap.set(topDir.dir, flatFlag);

    return {};
  };

  const matchLatestSemVer = (semVer, versions) => {
    const matched = versions.all.filter(v => internals.semVerMatch(semVer, v));
    debug("matched latest", matched, "for", semVer);
    return matched.length > 0 && matched[matched.length - 1];
  };

  const getResolvedVersion = versions => {
    const depRes = getDepResolutions(topDir, pkg);
    const r = depRes[moduleName];
    if (!r || versions.all.indexOf(r.resolved) < 0) {
      //
      // dynamically match latest version
      //
      if (pkg && flatFlag !== false) {
        const resolved = matchLatestSemVer("*", versions);
        depRes[moduleName] = { resolved };
        return resolved;
      }
      return undefined;
    }

    return r.resolved;
  };

  const moduleDir = path.join(topDir.dir, nodeModules, moduleName);
  const versions = internals.getModuleVersions(moduleName, moduleDir);
  debug("versions", versions, reqParts);
  const version = reqParts.semVer
    ? matchLatestSemVer(reqParts.semVer, versions)
    : getResolvedVersion(versions);

  //
  // unable to resolve a version for a dependency, error out
  //
  if (!version) {
    if (flatFlag === false) {
      return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
    }
    /* istanbul ignore next */
    return newReturn ? null : [request, []]; // force not found error out
  }

  if (flatFlag === undefined) {
    flatFlagMap.set(topDir.dir, true);
  }

  const versionFp =
    version === versions.default
      ? path.join(topDir.dir, nodeModules)
      : path.join(moduleDir, versionsDir, version);

  debug("versionFp", versionFp);

  /* istanbul ignore next */
  return newReturn ? [versionFp] : [request, [versionFp]];
}

function flatFindPath(request, paths, isMain) {
  if (!internals.useOriginalLookup(request)) {
    request = internals.parseRequest(request).request;
  }

  return this[ORIG_FIND_PATH](request, paths, isMain);
}

Module._resolveLookupPaths = flatResolveLookupPaths;
Module._findPath = flatFindPath;

module.exports = {
  flatResolveLookupPaths,
  restore: () => {
    Module._resolveLookupPaths = Module[ORIG_RESOLVE_LOOKUP_PATHS];
    Module._findPath = Module[ORIG_FIND_PATH];
    Module[ORIG_RESOLVE_LOOKUP_PATHS] = undefined;
    Module[ORIG_FIND_PATH] = undefined;
  },
  internals
};
