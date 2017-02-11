require("foo");
delete require.cache[require.resolve("foo")];
module.exports = require("foo");

