"use strict";

const requireAt = require("require-at");
const Path = require("path");
const Crypto = require("crypto");
const Fs = require("fs");
const chai = require("chai");
const expect = chai.expect;
const mkdirp = require("mkdirp");
const rimraf = require("rimraf");

const versionsDir = "__fv_";

function linkModule(name, app, options) {
  options = options || {};
  const fixtures = Path.join(__dirname, "..", "fixtures");
  const modLoc = Path.join(fixtures, name);
  const modLinkVersion = "symlink_" + Crypto.createHash("md5").update(modLoc)
    .digest("base64").replace(/[+/]/g, (m) => m === "+" ? "-" : "_").substr(0, 22);
  const appDir = Path.join(fixtures, app);
  const appNmMod = Path.join(appDir, "node_modules", name);
  const modLinkVersionDir = Path.join(appNmMod, versionsDir, modLinkVersion);
  mkdirp.sync(modLinkVersionDir);
  const modLinkDir = Path.join(modLinkVersionDir, name);
  if (!Fs.existsSync(modLinkDir)) {
    Fs.symlinkSync(modLoc, modLinkDir);
  }
  if (!options.noTarget) {
    const linkedFile = Path.join(modLinkVersionDir, "__linked_target.json");
    Fs.writeFileSync(linkedFile, JSON.stringify({
      target: modLoc,
      appDir,
      resolved: modLinkVersion
    }, null, 2) + "\n");
  }
  if (!options.noFrom) {
    const modLinkFrom = Path.join(modLoc, "node_modules", "__linked_from.json");
    Fs.writeFileSync(modLinkFrom, JSON.stringify({
      [appDir]: {
        _depResolutions: {
          foo: {
            resolved: "2.0.1"
          }
        }
      }
    }, null, 2) + "\n");
  }
  const depResFile = Path.join(appDir, "node_modules", "__dep_resolutions.json");
  const depRes = require(depResFile);
  depRes[name] = depRes[name] || {};
  depRes[name].resolved = modLinkVersion;
  Fs.writeFileSync(depResFile, JSON.stringify(depRes, null, 2) + "\n");
}


describe("flat-module", function () {
  let flatModule;
  let saveCwd = process.cwd();
  let appCwd;
  before(() => {
    flatModule = require("../../flat-module");
    process.chdir("test/fixtures/app");
    appCwd = process.cwd();
    rimraf.sync("node_modules/**/v_symlink*");
    rimraf.sync("../zoo/node_modules/__linked_from.json");
    rimraf.sync("/tmp/flat-test");
    linkModule("zoo", "app");
    linkModule("fox", "app", { noFrom: true });
  });

  after(() => {
    rimraf.sync("node_modules/**/v_symlink*");
    rimraf.sync("../zoo/node_modules/__linked_from.json");
    rimraf.sync("/tmp/flat-test");
    flatModule.restore();
    delete require.cache[require.resolve("optional-require")];
    require("optional-require");
    process.chdir(saveCwd);
  });

  afterEach(() => {
    process.chdir(appCwd);
  });

  it("should load the correct version of a module", () => {
    expect(require(Path.resolve("tests/test_foo")).foo.version).to.equal("1.1.0");
  });

  it("should load module with CWD within an installed module", () => {
    process.chdir(`node_modules/car/${versionsDir}/1.0.0/car/lib`);
    require(Path.resolve("index"));
  });

  it("should load module with CWD below dir of node_modules", () => {
    process.chdir("lib/lib2");
    require(Path.resolve("index"));
  });

  it("should load the correct version of a scoped module", () => {
    const scoped = require(Path.resolve("tests/test_scoped"));
    expect(scoped.bar.version).to.equal("2.0.1");
    expect(scoped.barLib).to.equal("bar");
  });

  it("should load a linked module", () => {
    const linked = require(Path.resolve("tests/test_linked"));
    expect(linked.zoo.foo.version).to.equal("2.0.1");
    expect(linked.zoo.name).to.equal("zoo");
    expect(linked.zoo.version).to.equal("symlink");
  });

  it("should load the latest of a dependency w/o resolved", () => {
    const x = require(Path.resolve("tests/test_missing-resolved"));
    expect(x.version).to.equal("5.10.7");
  });

  it("should load module w/o versions dir", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app/"), "no-fv-dir");
    expect(x.foo.version).to.equal("2.0.1");
    expect(x.version).to.equal("1.0.0");
    expect(x.name).to.equal("no-fv-dir");
  });

  it("should load latest from versions dir w/o default version", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app"), "car");
    expect(x.pkg.name).to.equal("car");
    expect(x.pkg.version).to.equal("1.0.0");
    expect(x.foo.version).to.equal("1.1.0");
  });

  it("should load default version with file", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app"), "default-file");
    expect(x.name).to.equal("default-file");
    expect(x.version).to.equal("11.29.3");
    expect(x.foo.version).to.equal("5.10.7");
  });

  it("should load default version with file that's empty", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app"), "default-file-empty");
    expect(x.name).to.equal("default-file-empty");
    expect(x.version).to.equal("14.5.4");
    expect(x.foo.version).to.equal("5.10.7");
  });


  it("should load default version w/o __fv_", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app"), "default-none");
    expect(x.name).to.equal("default-none");
    expect(x.version).to.equal("21.19.31");
    expect(x.foo.version).to.equal("3.7.1");
  });

  it("should fail to load specific version of module with only default version", () => {
    expect(() => requireAt(Path.join(__dirname, "../fixtures/app"), "default-none@3.5.9")).to.throw();
  });

  it("should load module with only default version even if resolved to a diff version", () => {
    const x = requireAt(Path.join(__dirname, "../fixtures/app"), "default-none-b");
    expect(x.name).to.equal("default-none-b");
    expect(x.version).to.equal("16.39.131");
    expect(x.foo.version).to.equal("3.7.1");
  });

  it("should fail if can't find package.json", () => {
    const tmpDir = "/tmp/flat-test/foo";
    mkdirp.sync(tmpDir);
    Fs.writeFileSync(Path.join(tmpDir, "index.js"), `require("foo");\n`);
    expect(() => require("/tmp/flat-test/foo")).to.throw();
  });

  it("should fail if module missing", () => {
    expect(() => require(Path.resolve("tests/test_missing"))).to.throw();
  });

  it("should fail if linked module missing __linked_from.json file", () => {
    expect(() => require(Path.resolve("tests/test_fox"))).to.throw();
  });

  it("should fail to load an installed module if it's missing package.json", () => {
    expect(() => require(Path.resolve("tests/test_missing-pkg"))).to.throw();
  });

  it("should fallback to original module system", () => {
    expect(require(Path.resolve("tests/test_noflat"))).to.deep.equal({
      foo: {
        name: "foo",
        version: "1.1.0",
      },
      qqq1: { qqq1: 1000 },
      qqq2: { qqq2: 1000 }
    });
  });

  it("should load a module with exact explicit version", () => {
    const x = require(Path.resolve("tests/test_by_version_exact"));
    expect(x.foo.version).to.equal("1.0.0");
  });

  it("should load a module with explicit version", () => {
    const x = require(Path.resolve("tests/test_by_version"));
    expect(x.foo3.version).to.equal("3.10.12");
  });

  it("should load a module's specific file with explicit version", () => {
    require(Path.resolve("tests/test_by_version_file"));
  });

  it("should fail when no matching with explicit version", () => {
    expect(() => require(Path.resolve("tests/test_by_version_no_matching"))).to.throw();
  });

  it("should fail when a file is missing with explicit version", () => {
    expect(() => require(Path.resolve("tests/test_by_version_missing"))).to.throw();
  });

  it("should work with require-at", () => {
    process.chdir(__dirname);
    const requireAtApp = requireAt(Path.resolve("../fixtures/another-app"));
    const foo = requireAtApp.resolve("foo");
    expect(foo).to.include(`test/fixtures/another-app/node_modules/foo/${versionsDir}/9.10.5/foo/index.js`);
  });

  describe("when in node repl", function () {
    it("should return proper paths when parent.filename is null (repl)", () => {
      const parent = {
        "id": "<repl>",
        "exports": {},
        "filename": null,
        "loaded": false,
        "children": [],
        "paths": []
      };
      expect(flatModule.flatResolveLookupPaths("foo", parent)).to.deep.equal(["foo",
        [Path.resolve(`node_modules/foo/${versionsDir}/1.1.0`)]]);
    });

    it("should load module with CWD below dir of node_modules (repl)", () => {
      const parent = {
        "id": "<repl>",
        "exports": {},
        "filename": null,
        "loaded": false,
        "children": [],
        "paths": []
      };
      process.chdir("lib/lib2");
      expect(flatModule.flatResolveLookupPaths("foo", parent)).to.deep.equal(
        ["foo", [Path.resolve(`../../node_modules/foo/${versionsDir}/1.1.0`)]]
      );
    });
  });

  describe("flat-module internals", function () {

    describe("findNearestPackage", function () {
      it("should stop at stopDir", () => {
        const dir = Path.normalize("/tmp/flat-test/pkg1/pkg-stop/pkg2/pkg3");
        mkdirp.sync(dir);
        Fs.writeFileSync(Path.normalize("/tmp/flat-test/pkg1/package.json"), JSON.stringify({ hello: 1 }));
        const pkg = flatModule.internals.findNearestPackage(dir, Path.normalize("/tmp/flat-test/pkg1/pkg-stop"));
        expect(pkg).to.be.undefined;
      });

      it("should stop at /", () => {
        const dir = "/tmp/flat-test/no-pkg1/no-pkg2/";
        mkdirp.sync(dir);
        const pkg = flatModule.internals.findNearestPackage(dir);
        expect(pkg).to.be.undefined;
      });
    });

    describe("isRelativePathRequest", function () {
      it("should return true for .", () => {
        expect(flatModule.internals.isRelativePathRequest(".")).to.be.true;
      });

      it("should return true for ..", () => {
        expect(flatModule.internals.isRelativePathRequest("..")).to.be.true;
      });

      it("should return true for request startsWith ./", () => {
        expect(flatModule.internals.isRelativePathRequest("./")).to.be.true;
        expect(flatModule.internals.isRelativePathRequest("./blah")).to.be.true;
      });

      it("should return true for request startsWith ../", () => {
        expect(flatModule.internals.isRelativePathRequest("../")).to.be.true;
        expect(flatModule.internals.isRelativePathRequest("../blah")).to.be.true;
      });

      it("should return false for .foo", () => {
        expect(flatModule.internals.isRelativePathRequest(".foo")).to.be.false;
      });

      it("should return false for .foo/bar", () => {
        expect(flatModule.internals.isRelativePathRequest(".foo/bar")).to.be.false;
      });

      it("should return false for foo", () => {
        expect(flatModule.internals.isRelativePathRequest("foo")).to.be.false;
      });

      it("should return false for foo/bar", () => {
        expect(flatModule.internals.isRelativePathRequest("foo/bar")).to.be.false;
      });
    });

    describe("semVerMatch", function () {
      const testMatch = (r, sv, vers) => {
        vers.forEach(
          (v) => chai.assert(flatModule.internals.semVerMatch(sv, v) === r,
            `Expect version ${v} to ${!r && "not" || ""} match semver ${sv}`)
        );
      };

      it("should match */x/X for anything", () => {
        testMatch(true, "*", ["", "1.1.2", "0.0.1", "1", "x"]);
        testMatch(true, "x", ["", "1.1.2", "0.0.1", "1", "x"]);
        testMatch(true, "X", ["", "1.1.2", "0.0.1", "1", "x"]);
        testMatch(true, "", ["", "1.1.2", "0.0.1", "1", "x"]);
      });

      it("should match 3/3. for major v3", () => {
        const v3 = ["3", "3.", "3.1", "3.10.", "3.9.12"];
        const v3sv = ["3", "3."];
        v3sv.forEach((sv) => {
          testMatch(true, sv, v3)
        });
      });

      it("should match 3.x/3.x./3.x.x for major v3", () => {
        const v3 = ["3", "3.", "3.1", "3.10.", "3.9.12"];
        const v3sv = ["3.x", "3.x.", "3.x.x", "3.*", "3.*.", "3.X.*", "3.x.X", "3.x.*"];
        v3sv.forEach((sv) => {
          testMatch(true, sv, v3)
        });
      });

      it("should not match 3 for non major v3", () => {
        const nonV3 = ["1.3", "2.3.", "2.3.x", "2.", "2.x.x", ".3", ".x.3", "0.x.3", "0.0.3"];
        ["3", "3.", "3.X", "3.x.X", "3.X.*"].forEach((sv) => {
          testMatch(false, sv, nonV3);
        });
      });

      it("should match exact sv", () => {
        const vers = ["0", "0.0", "0.1", "0.1.3", "1.2.3", "3.2", "1.2", "2", "2.3.3"];
        vers.forEach((v) => testMatch(true, v, [v]));
      });

      it("should match 2.x.5 for any minor", () => {
        const vm = ["2.1.5", "2.15.5", "2.0.5"];
        testMatch(true, "2.x.5", vm);
      });

      it("should not match 2.x.5 for bad major/patch", () => {
        const vm = ["3.2.4", "1.20.5", "0.2.3"];
        testMatch(false, "2.x.5", vm);
      });
    });

    describe("semVerCompare", function () {
      it("should return 0 for same values", () => {
        expect(flatModule.internals.semVerCompare("12345", "12345")).to.equal(0);
      });

      it("should return 0 for same version", () => {
        expect(flatModule.internals.semVerCompare("10.11.23", "10.11.23")).to.equal(0);
        expect(flatModule.internals.semVerCompare("v10.11.23", "10.11.23")).to.equal(0);
        expect(flatModule.internals.semVerCompare("10.11.23", "v10.11.23")).to.equal(0);
      });

      it("should match strings as is", () => {
        expect(flatModule.internals.semVerCompare("hello.world", "foo.bar")).to.equal(1);
        expect(flatModule.internals.semVerCompare("foo.bar", "hello.world")).to.equal(-1);
      });
    })

  });
});
