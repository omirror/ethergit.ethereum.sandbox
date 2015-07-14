define(function(require, exports, module) {
    main.consumes = [
        'Plugin', 'ui', 'layout', 'fs', 'find', 'tabManager', 'commands',
        'ethergit.libs',
        'ethergit.sandbox',
        'ethergit.solidity.compiler',
        'ethereum-console'
    ];
    main.provides = ['ethergit.sandbox.control'];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var ui = imports.ui;
        var layout = imports.layout;
        var fs = imports.fs;
        var find = imports.find;
        var tabs = imports.tabManager;
        var commands = imports.commands;
        var libs = imports['ethergit.libs'];
        var sandbox = imports['ethergit.sandbox'];
        var compiler = imports['ethergit.solidity.compiler'];
        var ethConsole = imports['ethereum-console'];

        var async = require('async');
        var utils = require('./utils');
        
        var $ = libs.jquery();
        var _ = libs.lodash();

        var control = new Plugin('Ethergit', main.consumes);
        
        control.on('load', function() {
            /*ui.insertByIndex(
                layout.getElement('barTools'),
                //require('text!./sandbox_control.html'),
                '<div>test</div>',
                320, ui
            );*/

            commands.addCommand({
                name: 'runSandbox',
                exec: function() {
                    ethConsole.logger(function(err, logger) {
                        if (err) return console.err(err);
                        logger.clear();
                        run(function(err) {
                            if (err) logger.error('<pre>' + err + '</pre>');
                        });
                    });
                }
            }, control);

            commands.addCommand({
                name: 'stopSandbox',
                exec: function() {
                    ethConsole.logger(function(err, logger) {
                        if (err) return console.err(err);
                        stop(function(err) {
                            if (err) logger.error(err);
                        });
                    });
                }
            }, control);

            var btnSandbox = ui.insertByIndex(
                layout.getElement('barTools'),
                new ui.button({
                    id: 'btnSandbox',
                    skin: 'c9-toolbarbutton-glossy',
                    command: 'runSandbox',
                    caption: 'Run Contracts',
                    disabled: false,
                    icon: 'run.png'
                }),
                300, control
            );

            sandbox.on('stateChanged', function() {
                var config = {
                    CLEAN: {
                        caption: 'Run Contracts',
                        disabled: false,
                        command: 'runSandbox'
                    },
                    STARTING: {
                        caption: 'Starting...',
                        disabled: true
                    },
                    ACTIVE: {
                        caption: 'Stop Sandbox',
                        disabled: false,
                        command: 'stopSandbox'
                    },
                    STOPPING: {
                        caption: 'Stopping...',
                        disabled: true
                    }
                };

                update(config[sandbox.state()]);
                
                function update(config) {
                    btnSandbox.setAttribute('caption', config.caption);
                    btnSandbox.setAttribute('disabled', config.disabled);
                    btnSandbox.setAttribute('command', config.command);
                }
            });
        });

        function run(cb) {
            if (sandbox.state() !== 'CLEAN') return cb('Sandbox is running already');
            
            async.series({
                config: loadConfig,
                contracts: compileContracts
            }, function(err, params) {
                if (err) cb(err);
                else async.series([
                    startSandbox.bind(this, params.config),
                    createContracts.bind(this, params.contracts)
                ], cb);
            });

            function loadConfig(cb) {
                async.waterfall([
                    read,
                    adjustValues,
                    calcPrivateKeys
                ], cb);
                
                function read(cb) {
                    fs.readFile('/ethereum.json', function(err, content) {
                        if (err) return cb(err);
                        try {
                            var config = JSON.parse(utils.removeMetaInfo(content));
                        } catch(e) {
                            return cb('Could not parse ethereum.json: ' + e.message);
                        }
                        cb(null, config);
                    });
                }
                function adjustValues(config, cb) {
                    if (!config.hasOwnProperty('env') || !config.env.hasOwnProperty('accounts') ||
                        Object.keys(config.env).length === 0) {
                        return cb('Please, add initial account(s) to ethereum.json');
                    }

                    try {
                        if (config.env.hasOwnProperty('block')) {
                            var block = config.env.block;
                            if (block.hasOwnProperty('coinbase'))
                                try {
                                    block.coinbase = address(block.coinbase);
                                } catch (e) {
                                    throw 'Could not parse block.address: ' + e;
                                }
                            _.each(
                                ['difficulty', 'gasLimit', 'number', 'timestamp'],
                                function(field) {
                                    if (block.hasOwnProperty(field)) {
                                        try {
                                            block[field] = value(block[field]);
                                        } catch (e) {
                                            throw 'Could not parse block.' + field + ': ' + e;
                                        }
                                    }
                                }
                            );
                        }

                        _.each(config.env.accounts, function(account) {
                            _.each(['balance', 'nonce'], function(field) {
                                if (account.hasOwnProperty(field)) {
                                    try {
                                        account[field] = value(account[field]);
                                    } catch (e) {
                                        throw 'Could not parse account.' + field + ': ' + e;
                                    }
                                }
                            });
                            if (account.hasOwnProperty('storage')) {
                                account.storage = _(account.storage).map(function(val, key) {
                                    try {
                                        var parsedKey = value(key);
                                    } catch (e) {
                                        throw 'Could not parse key of storage entry: ' + e;
                                    }
                                    try {
                                        return [parsedKey, value(val)];
                                    } catch (e) {
                                        throw 'Could not parse value of storage entry: ' + e;
                                    }
                                }).object().value();
                            }
                        });
                    } catch (e) {
                        return cb(e);
                    }
                    
                    cb(null, config);

                    function value(val) {
                        var type = typeof val;
                        var res;
                        if (type === 'number') {
                            res = utils.pad(val.toString(16));
                        } else if (type === 'string') {
                            if (val.indexOf('0x') === 0) {
                                res = utils.pad(val.substr(2));
                            } else if (/^\d+$/.test(val)) {
                                res = utils.pad(parseInt(val, 10).toString(16));
                            } else {
                                throw '"' + val + '" is not a decimal number (use 0x prefix for hexadecimal numbers)';
                            }
                        } else {
                            throw 'Value should be either number or string';
                        }
                        return res;
                    }
                    function address(val) {
                        if (typeof val !== 'string' || val.length !== 40)
                            throw 'Address should be a string with 40 characters';
                        return val;
                    }
                }
                function calcPrivateKeys(config, cb) {
                    try {
                        _.each(config.env.accounts, function(account) {
                            if (account.hasOwnProperty('pkey')) {
                                if (typeof account.pkey != 'string') {
                                    throw 'Private key should be a hexadecimal hash (64 symbols) or a string';                            }
                                if (account.pkey.length !== 64) {
                                    account.pkey = utils.sha3(account.pkey);
                                }
                            }
                        });
                    } catch (e) {
                        return cb(e);
                    }
                    cb(null, config);
                }
            }

            function compileContracts(cb) {
                async.waterfall([
                    findSolidityFiles,
                    compile
                ], cb);
                
                function findSolidityFiles(cb) {
                    find.findFiles({
                        path: '',
                        pattern : '*.sol',
                        buffer  : true
                    }, function(err, result) {
                        cb(null, result
                           .match(/.+(?=:)/g)
                           .map(function(path) { return '.' + path; }));
                    });
                }
                function compile(files, cb) {
                    if (files.length === 0) cb(null, []);
                    else {
                        compiler.binaryAndABI(files, function(err, compiled) {
                            if (err) {
                                if (err.type === 'SYNTAX') gotoLine(err);
                                cb(err.message);
                            }
                            else cb(null, compiled);
                        });
                    }

                    function gotoLine(err) {
                        tabs.open({
                            path: err.file,
                            focus: true
                        }, function(error, tab){
                            if (error) console.error(error);
                            else tab.editor.ace.gotoLine(err.line, err.column);
                        });
                    }
                }
            }

            function startSandbox(config, cb) {
                sandbox.start(config.env, cb);
            }

            function createContracts(contracts, cb) {
                async.eachSeries(contracts, function(contract, cb) {
                    sandbox.runTx({
                        data: contract.binary,
                        contract: contract
                    }, cb);
                }, cb);
            }
        }

        function stop(cb) {
            if (sandbox.state() !== 'ACTIVE') cb('Sandbox is not running');
            else sandbox.stop(cb);
        }
        
        register(null, { 'ethergit.sandbox.control': control });
    }
});
