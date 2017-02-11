"use strict";

const Path = require("path");
const Crypto = require("crypto");
const Fs = require("fs");
const chai = require("chai");
const expect = chai.expect;
const mkdirp = require("mkdirp");
const rimraf = require("rimraf");

function linkModule(name, app, options) {
  options = options || {};
  const fixtures = Path.join(__dirname, "..", "fixtures");
  const modLoc = Path.join(fixtures, name);
  const modLinkVersion = "v_symlink_" + Crypto.createHash("md5").update(modLoc)
      .digest("base64").replace(/[+/]/g, (m) => m === "+" ? "-" : "_").substr(0, 22);
  const appDir = Path.join(fixtures, app);
  const appNmMod = Path.join(appDir, "node_modules", name);
  const modLinkVersionDir = Path.join(appNmMod, modLinkVersion);
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
    linkModule("fox", "app", {noFrom: true});
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
    process.chdir("node_modules/car/v1.0.0/car/lib");
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
      qqq1: {qqq1: 1000},
      qqq2: {qqq2: 1000}
    });
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
        [Path.resolve("node_modules/foo/v1.1.0")]]);
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
        ["foo", [Path.resolve("../../node_modules/foo/v1.1.0")]]
      );
    });
  });

  describe("flat-module internals", function () {

    describe("findNearestPackage", function () {
      it("should stop at stopDir", () => {
        const dir = Path.normalize("/tmp/flat-test/pkg1/pkg-stop/pkg2/pkg3");
        mkdirp.sync(dir);
        Fs.writeFileSync(Path.normalize("/tmp/flat-test/pkg1/package.json"), JSON.stringify({hello: 1}));
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
    })

  });
});
