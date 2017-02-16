# node-flat-module

#### Flat module dependencies system for NodeJS

This is an implementation of a flat module dependencies system for NodeJS.

# Motivation

NodeJS's nested `node_modules` is simple and autonomous.  No matter where you
are, your require will find the nearest `node_modules` that contains the
module you want.  It's elegant and simple, but doesn't come cheap.  

The cost is duplicate modules, complexity of which is shifted to package 
managers, and it's a hard problem for them with no deterministic or perfect
solution.  NPM didn't offer a package hoisting solution to flatten duplicated
modules until version 3.  Even with the best hoisting, there's still bound to 
be duplications.

Node's module system also ignores any dependencies information and leaves that only to the 
package managers.

These lead to issues with deterministic module install and mixed up dependencies.

In my experience of using Node, these have been a constant source of problems in
development, testing, and production.

Trying to keep deterministic `node_modules` has always been tricky.  NPM's shrinkwrap
has been buggy and generally complicated and a clunky chore to maintain and update.

When there are some modules that are best if they are not duplicated, managing that
is not easy, and edge case issues occur during run time. 

During development, developers constantly changes dependencies, and lead to
completely unusable `node_modules` that requires full fresh installs.  I've help 
resolved countless mysterious issues developers faced by having them reinstall
everything.

Developing with `npm link`ing a module is generally a hit or miss thing.  There are so many
times that I had spent a lot of time helping someone debug an issue only to find out that
they are doing `npm link`, which ends up being the cause of the issue.

So instead of trying to write the best Node Package Manager with the most optimal hoisting
and flattening, and locking algorithms, another approach is to address the root of the complexity,
Node's `node_modules` system.

# Design Overview

  - No nested `node_modules`.  Only one `node_modules`.
    - Each module is installed under a directory that contains all the versions needed.  Therefore, one instance of each version of any module.
  - Dependencies information is retained and checked at run time.
    - The file `package.json` will be significant for dependencies version resolution at run time.
    - When package manager installs a module, it inserts a section `_depResolutions` into `package.json`.
    - For the application, a file `__dep_resolutions.json` will be saved to its `node_modules` directory.
    - You can explicitly specify a version in code when calling `require`
      - ie: `require("foo@3")` or `require("foo@3.5.x/lib/blah")`
    - In a section `extraDependencies` in package.json, you can use an array of multiple semvers for a dependency.
      - In case you have a lib that uses xyz but can work with multiple versions of xyz and you want to have tests for each one.
      - Mainly something for package manager to implement.
      - The first one in the array would be the default resolution.
  - Internally aware of linked modules to make `npm link` a more robust approach to module development.
    - Linked module will have a `node_modules` directory, within which is a `__linked_from.json` with linking and dependencies resolution info.
    - The application linking a module will have a `__linked_target.json` file with linking info for each linked module.
    - Dependencies for the linked module will be solely resolved from the application's `node_modules`.
  - Will fallback to original module system if no dependencies resolution information found.

## A sample

Here is how an application's `node_modules` might look like.  Captured from this module's test fixtures.

![sample](docs/sample_nm.png)
