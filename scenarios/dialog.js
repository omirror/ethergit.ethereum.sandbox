define(function(require) {
  main.consumes = [
    'Dialog', 'ui', 'layout', 'commands', 'menus', 'Menu', 'fs',
    'ethergit.libs', 'ethergit.sandbox', 'ethergit.dialog.scenario',
    'ethereum-console', 'ethergit.solidity.compiler'
  ];
  main.provides = ['ethergit.dialog.scenarios'];
  return main;

  function main(options, imports, register) {
    var Dialog = imports.Dialog;
    var ui = imports.ui;
    var layout = imports.layout;
    var commands = imports.commands;
    var menus = imports.menus;
    var Menu = imports.Menu;
    var fs = imports.fs;
    var libs = imports['ethergit.libs'];
    var sandbox = imports['ethergit.sandbox'];
    var scenarioDialog = imports['ethergit.dialog.scenario'];
    var ethConsole = imports['ethereum-console'];
    var compiler = imports['ethergit.solidity.compiler'];

    var async = require('async');
    
    var $ = libs.jquery();
    var _ = libs.lodash();
    var yaml = libs.yaml();

    var $scenarios, $error;

    var scenarioTmpl = _.template(
      '<li>' +
        '<a href="#" data-action="open" data-name="<%= name %>"><%= name %></a> ' +
        '<a href="#" data-action="run" data-name="<%= name %>" class="glyphicon glyphicon-play"></a> ' +
        '<a href="#" data-action="remove" data-name="<%= name %>" class="glyphicon glyphicon-remove"></a> ' +
        '</li>'
    );
    var dialog = new Dialog('Ethergit', main.consumes, {
      name: 'ethergit-dialog-scenarios',
      allowClose: true,
      title: 'Scenarios',
      width: 800,
      elements: [
        {
          type: 'button', id: 'close', color: 'blue',
          caption: 'Close', 'default': true, onclick: hide
        }
      ]
    });

    dialog.on('load', function() {
      commands.addCommand({
        name: 'showScenarios',
        exec: dialog.show.bind(dialog),
        isAvailable: function() {
          return !!sandbox.getId();
        }
      }, dialog);

      var btn = ui.insertByIndex(
        layout.getElement('barTools'),
        new ui.button({
          id: 'btnScenarios',
          skin: 'c9-toolbarbutton-glossy',
          command: 'showScenarios',
          caption: 'Scenarios',
          disabled: true
        }),
        440, dialog
      );

      if (!menus.get('Window/Ethereum').menu) {
        menus.addItemByPath('Window/~', new ui.divider(), 10300, dialog);
        menus.addItemByPath('Window/Ethereum', new Menu({}, dialog), 10320, dialog);
      }
      
      menus.addItemByPath(
        'Window/Ethereum/Scenarios',
        new ui.item({ command: 'showScenarios' }),
        180, dialog
      );

      sandbox.on('select', function() {
        btn.setAttribute('disabled', !sandbox.getId());
      });
    });

    dialog.on('draw', function(e) {
      e.html.innerHTML = require('text!./dialog.html');
      var $root = $(e.html);
      $scenarios = $root.find('[data-name=scenarios]');
      $error = $root.find('[data-name=error]');

      $scenarios.click(function(e) {
        var $el = $(e.target);
        var action = $el.data('action');
        if (action) {
          e.preventDefault();
          if (action == 'open') {
            scenarioDialog.showScenario($el.data('name'));
          } else if (action == 'run') {
            runScenario($el.data('name'));
          } else if (action == 'remove') {
            removeScenario($el.data('name'));
          }
        }
      });
      
      $root.keydown(function(e) { e.stopPropagation(); });
      $root.keyup(function(e) {
        e.stopPropagation();
        if (e.keyCode == 27) hide();
      });
    });

    dialog.on('show', function() {
      $scenarios.empty();
      $error.empty();
      
      sandbox.web3.sandbox.getProjectDir(function(err, projectDir) {
        if (err) return console.error(err);

        var scenariosDir = projectDir + 'scenarios/';
        
        fs.exists(scenariosDir, function(exists) {
          if (!exists) {
            $error.text('There is no directory ' + scenariosDir);
            return;
          }
            
          fs.readdir(scenariosDir, function(err, files) {
            if (err) return console.error(err);
            files = _.filter(files, function(file) {
              return _.endsWith(file.name, '.yaml');
            });
            async.map(files, function(file, cb) {
              fs.readFile(scenariosDir + file.name, function(err, content) {
                if (err) return cb(err);
                cb(null, {
                  name: file.name.substr(0, file.name.length - 5),
                  content: content
                });
              });
            }, function(err, scenarios) {
              if (err) return $error.text(err);
              _.each(scenarios, function(scenario) {
                $scenarios.append(scenarioTmpl({
                  name: scenario.name
                }));
              });
            });
          });
        });
      });
    });
    
    function hide() {
      dialog.hide();
    }

    function runScenario(name) {
      $error.empty();

      sandbox.web3.sandbox.getProjectDir(function(err, projectDir) {
        if (err) return $error.text(err);

        var file = projectDir + 'scenarios/' + name + '.yaml';
        fs.readFile(file, function(err, content) {
          if (err) return $error.text(err);

          try {
            var txs = yaml.safeLoad(content);
            var errors = validateScenario(txs);
            if (errors.length > 0) {
              $error.html(
                _.reduce(errors, function(html, error) {
                  return html + error + '<br/>';
                }, '')
              );
            } else {
              ethConsole.logger(function(err, logger) {
                if (err) return console.error(err);
                logger.log('Running scenario <b>' + name + '</b>');
                async.each(txs, runTx.bind(null, projectDir), function(err) {
                  if (err) logger.error(err);
                  else logger.log('Scenario has been executed successfully');
                });
              });
            }
          } catch (e) {
            $error.html('<pre>' + e + '</pre>');
          }
        });
      });
    }

    function removeScenario(name) {
      $error.empty();

      sandbox.web3.sandbox.getProjectDir(function(err, projectDir) {
        if (err) return $error.text(err);

        var file = projectDir + 'scenarios/' + name + '.yaml';
        fs.rmfile(file, function(err) {
          if (err) return $error.text(err);
          $scenarios.find('[data-name=' + name + ']').parent().remove();
        });
      });
    }

    function runTx(projectDir, params, cb) {
      if (_.has(params, 'contract')) {
        async.waterfall([
          compile,
          send
        ], cb);
      } else {
        sandbox.web3.eth.sendTransaction(params, cb);
      }

      function compile(cb) {
        compiler.binaryAndABI(
          params.contract.sources,
          projectDir + params.contract.dir,
          function(err, output) {
            if (err) {
              cb('<pre>' + err.message + '</pre>');
            } else {
              cb(null, output.contracts);
            }
          }
        );
      }
      function send(contracts, cb) {
        var contract = _.find(contracts, { name: params.contract.name });
        if (!contract) return cb('Could not find the contract ' + params.contract.name);

        deploy(contract, cb);

        function deploy(contract, cb) {
          if (contract.address) return cb();
          
          try {
            var libs = findLibs();
          } catch (err) {
            return cb(err);
          }
          
          if (libs.length != 0) {
            async.eachSeries(libs, deploy, function(err) {
              if (err) return cb(err);
              _.each(libs, function(lib) {
                putLibAddress(lib.name, lib.address);
              });
              deploy(contract, cb);
            });
          } else sendTx(params.contract.args, cb);

          function findLibs() {
            var match, libs = [], libRe = /[^_]__(\w{36})__[^_]/g;
            while (match = libRe.exec(contract.binary)) {
              if (_.some(libs, matchName.bind(null, match[1]))) continue;
              
              var lib = _.find(contracts, matchName.bind(null, match[1]));
              if (!lib) throw "There is no lib to link with " + match[1];
              libs.push(lib);
            }
            return libs;
            
            function matchName(nameWithUnderscores, lib) {
              var name = lib.name;
              if (name.length > 36) name = name.substr(0, 36);
              else if (name.length < 36) name += _.repeat('_', 36 - name.length);
              return nameWithUnderscores == name;
            }
          }
          function putLibAddress(name, address) {
            if (name.length > 36) name = name.substr(0, 36);
            var placeholder = '__' + name + '__';
            placeholder = placeholder + _.repeat('_', 40 - placeholder.length);
            var re = new RegExp(placeholder, 'g');
            contract.binary = contract.binary.replace(re, address.substr(2));
          }
          function sendTx(args, cb) {
            var txHash;

            contract.args = _.clone(args);

            args.push({
              contract: contract,
              data: contract.binary.length == 0 ? '0x00' : '0x' + contract.binary
            });
            args.push(function(err, newContract) {
              if (err) {
                // web3 doesn't check exceptions, so here's a workaround to show user an exception
                if (err.message === 'The contract code couldn\'t be stored, please check your gas amount.') {
                  sandbox.web3.sandbox.receipt(txHash, function(error, receipt) {
                    if (error) return cb(error);
                    if (receipt.exception) log('Exception in ' + contract.name + ' constructor: ' + receipt.exception);
                    else log('Contract ' + contract.name + ' has no code.');
                    cb();
                  });
                } else cb(err);
              }
              else if (newContract.address) {
                contract.address = newContract.address;
                cb();
              }
              else txHash = newContract.transactionHash;
            });
            var newContract = sandbox.web3.eth.contract(contract.abi);
            newContract.new.apply(newContract, args);
          }
        }
      }
    }

    function validateScenario(scenario) {
      if (!_.isArray(scenario))
        return ['Scenario must be an array of objects with details of its transactions.'];

      return _(scenario)
        .map(function(tx, num) {
          var errors = [];
          num++;
          if (!_.has(tx, 'from')) {
            errors.push('Transaction ' + num + ' must have a field [from]');
          } else if (!isAddress(tx.from)) {
            errors.push('Transaction ' + num + ' must contain an address in the field [from]');
          }
          if (_.has(tx, 'to') && !_.isNull(tx.to) && !isAddress(tx.to)) {
            errors.push('Transaction ' + num + ' must contain an address in the field [to]');
          }
          if (_.has(tx, 'value') && !_.isNull(tx.value) && !isNumber(tx.value)) {
            errors.push('Transaction ' + num + ' must contain a number in the field [value]');
          }
          if (_.has(tx, 'data') && !_.isNull(tx.data) && !isHex(tx.data)) {
            errors.push('Transaction ' + num + ' must contain a hex-data in the field [data]');
          }
          return errors;
        })
        .flatten()
        .value();

      function isAddress(str) {
        return /^0x[\dabcdef]{40}$/.test(str.toLowerCase());
      }
      function isNumber(value) {
        return _.isNumber(value) || /^0x[\dabcdef]+$/.test(value.toLowerCase());
      }
      function isHex(value) {
        return /^0x[\dabcdef]+$/.test(value.toLowerCase());
      }
    }

    dialog.freezePublicAPI({});

    register(null, {
      'ethergit.dialog.scenarios': dialog
    });
  }
});
