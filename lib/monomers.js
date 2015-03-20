/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
'use strict';
// jshint -W079
var Promise = global.Promise || require('es6-promise').Promise;
// jshint +W079

var dom5 = require('dom5');
var jsParse = require('./ast-utils/js-parse');
var importParse = require('./ast-utils/import-parse');
var url = require('url');

function reduceMetadata(m1, m2) {
  return {
    elements: m1.elements.concat(m2.elements),
    modules: m1.modules.concat(m2.modules)
  };
}

var EMPTY_METADATA = {elements: [], modules: []};

/**
* Parse5's representation of a parsed html document.
* @typedef {Object} DocumentAST
*/

/**
* The metadata for a single polymer element.
* @typedef {Object} ElementMonomer
*/

/**
* The metadata for a javascript module.
* @typedef {Object} ModuleMonomer
*/

/**
 * The metadata for all modules and elements defined in one document.
 * @typedef {Object} Metadata
 * @property {Array.<ElementMonomer>} elements The elements from the document.
 * @property {Array.<ElementMonomer>} modules The modules from the document.
 */

/**
* The metadata of an entire HTML document, in promises.
* @typedef {Object} HTMLMonomer
* @property {string} href The url of the document.
* @property {Promise.<ParsedImport>} htmlLoaded The parsed representation of
*                                               the doc. Use the `ast`
*                                               property to get the full
*                                               `parse5` ast.
*
* @property {Promise.<Array.<string>>} depsLoaded Resolves to the list of this
*                                                 Document's import
*                                                 dependencies
*
* @property {Promise.<Metadata>} metadataLoaded Resolves to the list of
*                                                     this Document's import
*                                                     dependencies
*/

/**
* A database of polymer elements and select js modules defined in HTML.
*
* @param  {string} htmlImport The raw text to process.
* @param  {boolean} attachAST  If true, attach a parse5 compliant AST.
* @param  {string} href       The URL of the element.
* @param  {FileLoader=} loader An optional `FileLoader` used to load external
*                              resources.
*/
var Monomers = function Monomers(htmlImport,
                                 attachAST,
                                 href,
                                 loader) {
  this.htmlImport = htmlImport;
  this.attachAST = attachAST;
  this.href = href;
  this.loader = loader;

  this.elements = {};
  this.modules = {};

  /**
   * A map, keyed by absolute path, of Monomer metadata.
   * @type {Object}
   */
  this.html = {};
  this.root = this._parseHTML(htmlImport, href);
};

/**
 * Returns an HTMLMonomer representing the provided document.
 * @param  {string} htmlImport Raw text of an HTML document.
 * @param  {string} href       The document's URL.
 * @return {HTMLMonomer}       A `HTMLMonomer`
 */
Monomers.prototype._parseHTML = function _parseHTML(htmlImport,
                                                  href) {
  if (href in this.html) {
    return this.html[href];
  }
  var depsLoaded = [];
  var depHrefs = [];
  var metadataLoaded = Promise.resolve(EMPTY_METADATA);
  var parsed;
  try {
    parsed = importParse(htmlImport);
  } catch (err) {
    console.log(err);
    console.log('Error parsing!');
    throw err;
  }
  var htmlLoaded = Promise.resolve(parsed);
  if (parsed.script) {
    metadataLoaded = this._processScripts(parsed.script, href);
    depsLoaded.push(metadataLoaded);
  }

  if (this.loader) {
    parsed.import.forEach(function(link) {
      var linkurl = dom5.getAttribute(link, 'href');
      if (linkurl) {
        var resolvedUrl = url.resolve(href, linkurl);
        depHrefs.push(resolvedUrl);
        var dep = this.loader.request(resolvedUrl).then(function(content) {
          return this._parseHTML(content, resolvedUrl).depsLoaded;
        }.bind(this));
        depsLoaded.push(dep);
      }
    }.bind(this));
  }
  depsLoaded = Promise.all(depsLoaded)
        .then(function() {return depHrefs;})
        .catch(function(err) {throw err;});
  this.html[href] = {
      href: href,
      htmlLoaded: htmlLoaded,
      metadataLoaded: metadataLoaded,
      depsLoaded: depsLoaded
  };
  return this.html[href];
};

Monomers.prototype._processScripts = function _processScripts(scripts, href) {
  var scriptPromises = [];
  scripts.forEach(function(script) {
    scriptPromises.push(this._processScript(script, href));
  }.bind(this));
  return Promise.all(scriptPromises).then(function(metadataList) {
    return metadataList.reduce(reduceMetadata, EMPTY_METADATA);
  });
};

Monomers.prototype._processScript = function _processScript(script, href) {
  var src = dom5.getAttribute(script, 'src');
  var parsedJs;
  if (!src) {
    parsedJs = jsParse(script.childNodes[0].value, this.attachAST);
    if (parsedJs.elements) {
      parsedJs.elements.forEach(function(element) {
        if (element.is in this.elements) {
          throw new Error('Duplicate element definition: ' + element.is);
        } else {
          this.elements[element.is] = element;
        }
      }.bind(this));
    }
    if (parsedJs.modules) {
      parsedJs.modules.forEach(function(module) {
        if (module.is in this.modules) {
          throw new Error('Duplicate module definition: ' + module.is);
        }
        this.modules[module.is] = module;
      });
    }
    return parsedJs;
  }
  if (this.loader) {
    var resolvedSrc = url.resolve(href, src);
    return this.loader.request(resolvedSrc).then(function(content) {
      var resolvedScript = Object.create(script);
      resolvedScript.childNodes = [{value: content}];
      resolvedScript.attrs = resolvedScript.attrs.slice();
      dom5.removeAttribute(resolvedScript, 'src');
      return this._processScript(resolvedScript, href);
    }.bind(this)).catch(function(err) {throw err;});
  } else {
    return Promise.resolve(EMPTY_METADATA);
  }
};

/**
 * Returns a promise that resolves to a POJO representation of the import
 * tree.
 */
Monomers.prototype.metadataTree = function metadataTree() {
  return this._metadataTree(this.root, {});
};

Monomers.prototype._metadataTree = function _metadataTree(htmlMonomer,
                                                          loadedHrefs) {
  return htmlMonomer.metadataLoaded.then(function(metadata) {
    return htmlMonomer.depsLoaded.then(function(hrefs) {
      var depMetadata = [];
      hrefs.forEach(function(href) {
        if (!loadedHrefs[href]) {
          loadedHrefs[href] = true;
          var metadataPromise = Promise.resolve(true);
          if (depMetadata.length > 0) {
            metadataPromise = depMetadata[depMetadata.length - 1];
          }
          metadataPromise = metadataPromise.then(function() {
            return this._metadataTree(this.html[href], loadedHrefs);
          }.bind(this));
          depMetadata.push(metadataPromise);
        } else {
          depMetadata.push(Promise.resolve({}));
        }
      }.bind(this));
      return Promise.all(depMetadata).then(function(importMetadata) {
        metadata.imports = importMetadata;
        metadata.href = htmlMonomer.href;
        return htmlMonomer.htmlLoaded.then(function(parsedHtml) {
          metadata.html = parsedHtml;
          if (metadata.elements) {
            metadata.elements.forEach(function(element) {
              attachDomModule(parsedHtml, element);
            });
          }
          return metadata;
        });
      });
    }.bind(this));
  }.bind(this));
};

function attachDomModule(parsedImport, element) {
  var domModules = parsedImport['dom-module'];
  for (var i = 0, domModule; i < domModules.length; i++) {
    domModule = domModules[i];
    if (dom5.getAttribute(domModule, 'id') === element.is) {
      element.domModule = domModule;
      return;
    }
  }
}

module.exports = Monomers;