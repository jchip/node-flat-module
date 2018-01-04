"use strict";

const Module = require("module");
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const ORIG_RESOLVE_LOOKUP_PATHS = Symbol("node-flat-module-orig-resolve-lookup-paths");
const ORIG_FIND_PATH = Symbol("node-flat-module-orig-find-path");

assert(!Module[ORIG_RESOLVE_LOOKUP_PATHS], "Flat Module system already installed");

Module[ORIG_RESOLVE_LOOKUP_PATHS] = Module._resolveLookupPaths;
Module[ORIG_FIND_PATH] = Module._findPath;

const DIR_MAP = new Map();
const __FV_DIR = "__fv_";

const debug = () => undefined;
// const debug = console.log;
const NODE_MODULES = "node_modules";
const PACKAGE_JSON = "package.json";

let internals = {};

internals.getLinkedInfo = dir => {
  const linkedF = path.join(dir, "__fyn_link__.json");
  if (fs.existsSync(linkedF)) {
    const linked = internals.readJSON(linkedF);
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
// node_modules directory, have a __fyn_link__.json with a list
// of directories for apps that have linked to it.  When that file is detected
// and CWD is listed in it, then switch to looking in CWD for node_modules.
//
// linked module should:
//   - has all its dependencies installed in host's node_modules
//   - has a __fyn_link__.json in its own node_modules
//   - (optionally) has its own __fyn_resolutions__.json, use when being developed itself
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
//   - create __fyn_resolutions__.json under CWD/node_modules
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
  return internals.searchUpDir(originDir, null, null, dir => {
    const dm = internals.getDirMap(dir);

    if (dm.hasOwnProperty("top")) {
      // already known to qualify as top dir or not
      return dm.top && dm;
    }

    const nmDir = path.join(dir, NODE_MODULES);
    if (fs.existsSync(nmDir)) {
      // yay, found node_modules
      // but is it a linked module?
      const linkedInfo = internals.getLinkedInfo(nmDir);

      if (linkedInfo) {
        // switch topDir to CWD for linked mod
        dm.top = process.cwd();
        dm.linkedInfo = linkedInfo;
      } else {
        dm.top = dir;
      }

      //
      // Look for topDir/node_modules/__fyn_resolutions__.json
      //
      const ff = path.join(dm.top, NODE_MODULES, "__fyn_resolutions__.json");
      if (fs.existsSync(ff)) {
        dm.depRes = internals.readJSON(ff);
      }

      return dm;
    }

    // remember that dir has already been checked but not qualify as top dir
    return (dm.top = undefined);
  });
};

internals.readJSON = f => {
  return JSON.parse(fs.readFileSync(f));
};

internals.getDirMap = dir => {
  if (!DIR_MAP.has(dir)) {
    DIR_MAP.set(dir, {});
  }

  return DIR_MAP.get(dir);
};

internals.readPackage = dir => {
  const dm = internals.getDirMap(dir);

  if (dm.hasOwnProperty("pkg")) return dm.pkg;

  const pkgFile = path.join(dir, PACKAGE_JSON);
  if (!fs.existsSync(pkgFile)) {
    return (dm.pkg = undefined);
  }

  const pkg = internals.readJSON(pkgFile);

  dm.pkg = {
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies
  };

  const bd = pkg.bundledDependencies || pkg.bundleDependencies;
  if (bd) dm.pkg.bundledDependencies = bd;
  if (pkg._depResolutions) dm.pkg._depResolutions = pkg._depResolutions;
  if (pkg._flatVersion) dm.pkg._flatVersion = pkg._flatVersion;
  if (pkg.fyn) dm.pkg.fallbackToDefault = pkg.fyn.fallbackToDefault;

  return dm.pkg;
};

internals.findMappedPackage = (dir, stopDir, singleStops) => {
  return internals.searchUpDir(dir, stopDir, singleStops, x => {
    return internals.getDirMap(dir).pkg;
  });
};

// search from <dir> up to <stopDir> or / for the file package.json
internals.findNearestPackage = (dir, stopDir, singleStops) => {
  const mappedPkg = internals.findMappedPackage(dir, stopDir, singleStops);
  if (mappedPkg) return mappedPkg;

  return internals.searchUpDir(dir, stopDir, singleStops, x => {
    return internals.readPackage(x);
  });
};

//
// Find module name by matching dir name to request under <dir>/node_modules
// For handling calls like: require("foo/lib/bar") and require("@ns/foo")
//
internals.findModuleName = (dir, request) => {
  const splits = request.split("/");
  // is it a simple require("foo")?
  if (splits.length < 2) {
    return request;
  }

  const hasPkgOrFV = d => internals.readPackage(d) || internals.getModuleVersions(d).fv;

  dir = path.join(dir, NODE_MODULES);

  let i;
  for (i = 0; i < splits.length; i++) {
    dir = path.join(dir, splits[i]);
    if (hasPkgOrFV(dir)) {
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
  /* istanbul ignore next */
  if (request === "<repl>") return true;
  return path.isAbsolute(request) || internals.isRelativePathRequest(request);
};
//
// - parse require string in the form of:
// 1. "name@version" => {request: "name", semVer: "version"}
// 2. "name@version/path/to/mod" => {request: "name/path/to/mod", semVer: "version"}
// ie: require("debug@2.6.8")
// - version supports semver in the form of x.x.x, ie: 2.x.x
//
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

internals.getModuleVersions = modDir => {
  debug("getModuleVersions", modDir);

  const dm = internals.getDirMap(modDir);

  if (dm.hasOwnProperty("versions")) {
    return dm.versions || { all: [] };
  }

  if (fs.existsSync(modDir)) {
    const versions = {};
    if (!dm.hasOwnProperty("pkg")) {
      internals.readPackage(modDir);
    }

    const vDir = path.join(modDir, __FV_DIR);
    const all = fs.existsSync(vDir) ? fs.readdirSync(vDir) : [];

    if (all.length > 0) versions.fv = true;

    //
    // does there exist a default version
    //
    if (dm.pkg && dm.pkg._flatVersion) {
      if (all.indexOf(dm.pkg._flatVersion) < 0) {
        all.push(dm.pkg._flatVersion);
      }

      versions.default = dm.pkg._flatVersion;
    }

    if (all.length > 0) {
      versions.all = all.sort(internals.semVerCompare);
      dm.versions = versions;
    }
  }

  if (!dm.hasOwnProperty("versions")) {
    dm.versions = undefined;
  }

  return dm.versions || { all: [] };
};

// lookup specific version mapped for parent inside its nearest package.json
internals.getDepResolutions = (dirInfo, pkg, request) => {
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

  const linkedInfo = dirInfo.linkedInfo;
  if (linkedInfo && linkedInfo._depResolutions) {
    debug(`Using linkedInfo._depResolutions for ${request}`);
    return linkedInfo._depResolutions;
  }

  if (dirInfo.depRes) {
    return dirInfo.depRes;
  }

  //
  // can't find _depResolutions, fallback to original node module resolution.
  //
  assert(
    dirInfo.flat === undefined,
    `${request} flat module can't determine dep resolution but flat mode is already ${dirInfo.flat}`
  );
  debug("no depRes found, setting dirInfo.flat to false");
  dirInfo.flat = false;

  return {};
};

function flatResolveLookupPaths(request, parent, newReturn) {
  if (internals.useOriginalLookup(request, parent)) {
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
  }

  const reqParts = internals.parseRequest(request);
  request = reqParts.request;

  debug(`flat _resolveLookupPaths: request ${request} parent.id ${parent && parent.id}`);

  const parentDir = parent.filename && path.dirname(parent.filename);
  const originDir = parentDir || process.cwd();
  const dirInfo = internals.searchTopDir(originDir);

  debug("dirInfo", dirInfo);

  if (dirInfo.flat === false) {
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
  }

  //
  // search from parent's location up to topDir or / for package.json and load it
  // stopping if a directory named node_modules is seen since
  // that means what's being searched is an installed module and should have
  // a package.json found already.
  //
  const pkg = internals.findNearestPackage(originDir, dirInfo.top, [NODE_MODULES]);
  const moduleName = internals.findModuleName(dirInfo.top, request);

  //
  // Pkg has bundledDependencies: use original module system
  //
  if (pkg && pkg.bundledDependencies && pkg.bundledDependencies.indexOf(moduleName) >= 0) {
    debug("has bundledDependencies", originDir, dirInfo.top);
    dirInfo.flat = false;
    return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
  }

  // If can't figure out top dir, then give up.
  if (!dirInfo.top) {
    /* istanbul ignore next */
    return newReturn ? null : [request, []]; // force not found error out
  }

  //
  // Now we should've figured out where to find parent's dependencies.
  // Next resolve the version of the module to load.
  //

  const matchLatestSemVer = (semVer, versions) => {
    const matched = versions.all.filter(v => internals.semVerMatch(semVer, v));
    debug("matched latest", matched, "for", semVer);
    return matched.length > 0 && matched[matched.length - 1];
  };

  const getResolvedVersion = versions => {
    const depRes = internals.getDepResolutions(dirInfo, pkg, request);
    const r = depRes[moduleName];
    if (!r || versions.all.indexOf(r.resolved) < 0) {
      //
      // dynamically match latest version
      //
      if (pkg && dirInfo.flat !== false) {
        const resolved = matchLatestSemVer("*", versions);
        depRes[moduleName] = { resolved };
        return resolved;
      }
      return undefined;
    }

    return r.resolved;
  };

  const moduleDir = path.join(dirInfo.top, NODE_MODULES, moduleName);
  const versions = internals.getModuleVersions(moduleDir);
  const version = reqParts.semVer
    ? matchLatestSemVer(reqParts.semVer, versions)
    : getResolvedVersion(versions);

  debug("versions", versions, reqParts, "version", version);

  //
  // unable to resolve a version for a dependency, error out
  //
  if (!version) {
    if (dirInfo.flat === false) {
      debug("flat false, original lookup");
      return this[ORIG_RESOLVE_LOOKUP_PATHS](request, parent, newReturn);
    }

    if (versions.default && pkg && pkg.fallbackToDefault === true) {
      debug("fallback to default");
      version = versions.default;
    } else {
      debug("no version, fail");
      /* istanbul ignore next */
      return newReturn ? null : [request, []]; // force not found error out
    }
  }

  if (dirInfo.flat === undefined) {
    dirInfo.flat = true;
  }

  const versionFp =
    version === versions.default
      ? path.join(dirInfo.top, NODE_MODULES)
      : path.join(moduleDir, __FV_DIR, version);

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
