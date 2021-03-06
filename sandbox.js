define(function(require, exports, module) {
  main.consumes = ['Plugin', 'http', 'dialog.error', 'ethergit.libs'];
  main.provides = ['ethergit.sandbox'];
  return main;

  function main(options, imports, register) {
    this.version = JSON.parse(require('text!./package.json')).version;
    
    var Plugin = imports.Plugin;
    var http = imports.http;
    var showError = imports['dialog.error'].show;
    var libs = imports['ethergit.libs'];
    
    var async = require('async');
    var utils = require('./utils');
    var Contract = require('./contract');

    var Web3 = libs.web3();
    var _ = libs.lodash();
    var web3Formatters = libs.formatters();

    var formatter = require('./formatter')(_);

    var web3 = new Web3();

    var plugin = new Plugin('Ethergit', main.consumes);
    var emit = plugin.getEmitter();
    var id, pinnedId = null, filters = {};
    var sandboxUrl = '//' + window.location.hostname + ':8555/sandbox/';

    web3._extend({
      property: 'sandbox',
      methods: [
        new web3._extend.Method({
          name: 'createAccounts',
          call: 'sandbox_createAccounts',
          params: 1
        }),
        new web3._extend.Method({
          name: 'addAccounts',
          call: 'sandbox_addAccounts',
          params: 1
        }),
        new web3._extend.Method({
          name: 'setBlock',
          call: 'sandbox_setBlock',
          params: 1
        }),
        new web3._extend.Method({
          name: 'defaultAccount',
          call: 'sandbox_defaultAccount',
          params: 0
        }),
        new web3._extend.Method({
          name: 'accounts',
          call: 'sandbox_accounts',
          params: 1
        }),
        new web3._extend.Method({
          name: 'runTx',
          call: 'sandbox_runTx',
          params: 1
        }),
        new web3._extend.Method({
          name: 'contracts',
          call: 'sandbox_contracts',
          params: 0
        }),
        new web3._extend.Method({
          name: 'contract',
          call: 'sandbox_contract',
          params: 1
        }),
        new web3._extend.Method({
          name: 'transactions',
          call: 'sandbox_transactions',
          params: 1
        }),
        new web3._extend.Method({
          name: 'receipt',
          call: 'sandbox_receipt',
          params: 1
        }),
        new web3._extend.Method({
          name: 'setProjectName',
          call: 'sandbox_setProjectName',
          params: 1
        }),
        new web3._extend.Method({
          name: 'setBreakpoint',
          call: 'sandbox_setBreakpoint',
          params: 2
        }),
        new web3._extend.Method({
          name: 'setProjectDir',
          call: 'sandbox_setProjectDir',
          params: 1
        }),
        new web3._extend.Method({
          name: 'newMessageFilter',
          call: 'sandbox_newMessageFilter',
          params: 0
        }),
        new web3._extend.Method({
          name: 'getFilterChanges',
          call: 'sandbox_getFilterChanges',
          params: 1
        }),
        new web3._extend.Method({
          name: 'uninstallFilter',
          call: 'sandbox_uninstallFilter',
          params: 1
        })
      ],
      properties: [
        new web3._extend.Property({
          name: 'id',
          getter: 'sandbox_id'
        }),
        new web3._extend.Property({
          name: 'gasLimit',
          getter: 'sandbox_gasLimit',
          outputFormatter: web3Formatters.outputBigNumberFormatter
        }),
        new web3._extend.Property({
          name: 'projectName',
          getter: 'sandbox_projectName'
        }),
        new web3._extend.Property({
          name: 'projectDir',
          getter: 'sandbox_projectDir'
        })
      ]
    });
    
    web3._extend({
      property: 'debug',
      methods: [
        new web3._extend.Method({
          name: 'setBreakpoints',
          call: 'debug_setBreakpoints',
          params: 1
        }),
        new web3._extend.Method({
          name: 'removeBreakpoints',
          call: 'debug_removeBreakpoints',
          params: 1
        }),
        new web3._extend.Method({
          name: 'newBreakpointFilter',
          call: 'debug_newBreakpointFilter',
          params: 0
        }),
        new web3._extend.Method({
          name: 'getFilterChanges',
          call: 'debug_getFilterChanges',
          params: 1
        }),
        new web3._extend.Method({
          name: 'uninstallFilter',
          call: 'debug_uninstallFilter',
          params: 1
        }),
        new web3._extend.Method({
          name: 'resume',
          call: 'debug_resume',
          params: 0
        }),
        new web3._extend.Method({
          name: 'stepInto',
          call: 'debug_stepInto',
          params: 0
        }),
        new web3._extend.Method({
          name: 'stepOver',
          call: 'debug_stepOver',
          params: 0
        }),
        new web3._extend.Method({
          name: 'stepOut',
          call: 'debug_stepOut',
          params: 0
        })
      ],
      properties: [
        new web3._extend.Property({
          name: 'enabled',
          getter: 'debug_enabled'
        })
      ]
    });

    var cache = {
      data: {},
      init: function() {
        plugin.on('select', this.reset.bind(this));
      },
      reset: function() {
        this.data = {};
      }
    };
    cache.init();
    
    function select(sandboxId) {
      pinnedId = null;
      if (id) {
        _.invoke(filters, 'stopWatching');
        connectionWatcher.stop();
      }
      if (sandboxId != id) {
        id = sandboxId;
        if (id) {
          web3.setProvider(new Web3.providers.HttpProvider(sandboxUrl + id));
          setDefaultAccount();
          setupFilters();
          connectionWatcher.start();
        }
        emit('select');
      }
    }
    
    function start(projectName, projectDir, debug, config, cb) {
      var accounts = _(config.env.accounts)
          .pairs()
          .filter(function(account) {
            return account[1].hasOwnProperty('pkey');
          })
          .reduce(function(result, account) {
            result[account[0]] = {
              pkey: account[1].pkey,
              'default': account[1]['default']
            };
            return result;
          }, {});
      
      async.series([
        create,
        function(cb) {
          web3.setProvider(
            new Web3.providers.HttpProvider(sandboxUrl + id)
          );
          cb();
        },
        web3.sandbox.setProjectName.bind(web3.sandbox, projectName),
        web3.sandbox.setProjectDir.bind(web3.sandbox, projectDir),
        web3.sandbox.setBlock.bind(web3.sandbox, config.env.block),
        web3.sandbox.addAccounts.bind(web3.sandbox, accounts),
        setDefaultAccount,
        async.asyncify(setupFilters),
        async.asyncify(connectionWatcher.start.bind(connectionWatcher))
      ], function(err) {
        if (err) id = null;
        emit('select');
        cb(err);
      });

      function create(cb) {
        var query = {};
        if (pinnedId != null) query.id = pinnedId;
        
        http.request(sandboxUrl, {
          method: 'POST',
          query: query,
          contentType: 'application/json',
          body: JSON.stringify({
            debug: debug,
            plugins: config.hasOwnProperty('plugins') ? config.plugins : {}
          }),
          timeout: 20000
        }, function(err, data) {
          if (err) return cb(err);
          id = data.id;
          cb();
        });
      }
    }

    function setupFilters() {
      filters['block'] = web3.eth.filter('latest');
      filters['block'].watch(function(err, result) {
        if (err) return console.error(err);
        web3.eth.getBlock(result, function(err, block) {
          if (err) console.error(err);
          else if (block.transactions.length >0) emit('changed', result);
        });
      });
    }

    var connectionWatcher = {
      handler: undefined,
      start: function() {
        this.handler = setInterval(function() {
          try {
            web3.net.getListening(function(err, result) {
              if (err || !result) stopSandbox();
            });
          } catch (e) {
            stopSandbox();
          }
          function stopSandbox() {
            showError('The sandbox has been stopped.');
            select();
          }
        }, 5000);
      },
      stop: function() {
        clearInterval(this.handler);
      }
    };

    function setDefaultAccount(cb) {
      web3.sandbox.defaultAccount(function(err, address) {
        if (err) {
          if (cb) cb(err);
          else console.error(err);
        } else {
          web3.eth.defaultAccount = address;
          if (cb) cb();
        }
      });
    }
    
    function stop(cb) {
      _.invoke(filters, 'stopWatching');
      connectionWatcher.stop();
      http.request(sandboxUrl + id, { method: 'DELETE', timeout: 20000 }, function(err, data) {
        if (err) console.error(err);
        id = null;
        emit('select');
        cb();
      });
    }

    function list(cb) {
      http.request(sandboxUrl, { method: 'GET', timeout: 20000 }, cb);
    }

    function isDebugEnabled(cb) {
      if (!id) {
        var msg = 'There is no active sandbox';
        if (cb) cb(msg);
        else throw msg;
      } else {
        if (_.has(cache.data, 'isDebugEnabled')) {
          if (cb) cb(null, cache.data.isDebugEnabled);
          else return cache.data.isDebugEnabled;
        } else {
          if (cb) {
            web3.debug.getEnabled(function(err, enabled) {
              if (err) return cb(err);
              cache.data.isDebugEnabled = enabled;
              cb(null, enabled);
            });
          } else {
            var enabled = web3.debug.enabled;
            cache.data.isDebugEnabled = enabled;
            return enabled;
          }
        }
      }
    }

    function getProjectDir(cb) {
      if (!id) {
        var msg = 'There is no active sandbox';
        if (cb) cb(msg);
        else throw msg;
      } else {
        if (_.has(cache.data, 'projectDir')) {
          if (cb) cb(null, cache.data.projectDir);
          else return cache.data.projectDir;
        } else {
          if (cb) {
            web3.sandbox.getProjectDir(function(err, projectDir) {
              if (err) return cb(err);
              cache.data.projectDir = projectDir;
              cb(null, projectDir);
            });
          } else {
            var projectDir = web3.sandbox.projectDir;
            cache.data.projectDir = projectDir;
            return projectDir;
          }
        }
      }
    }

    plugin.freezePublicAPI({
      get web3() { return web3; },
      getId: function() { return id; },
      pinnedId: function() { return pinnedId; },
      pinOrUnpin: function() { pinnedId = pinnedId == null ? id : null; },
      select: select,
      start: start,
      stop: stop,
      list: list,
      runTx: web3.sandbox.runTx.bind(web3.sandbox),
      accounts: web3.sandbox.accounts.bind(web3.sandbox),
      contracts: web3.sandbox.contracts.bind(web3.sandbox),
      transactions: web3.sandbox.transactions.bind(web3.sandbox),
      coinbase: web3.eth.getCoinbase.bind(web3.eth),
      isDebugEnabled: isDebugEnabled,
      getProjectDir: getProjectDir
    });
    
    register(null, {
      'ethergit.sandbox': plugin
    });
  }
});
