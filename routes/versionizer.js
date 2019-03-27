'use strict';

const { debug, info, warn, error } = require('portal-env').Logger('portal-api:versionizer');
const fs = require('fs');
const path = require('path');
const folderHash = require('folder-hash');

const utils = require('./utils');
const dao = require('../dao/dao');

const versionizer = function () { };

versionizer._configHash = null;
versionizer.sendConfigHash = function (req, res, next) {
    debug('getConfigHash()');
    res.send(versionizer.getConfigHash());
};

versionizer.initConfigHash = function (callback) {
    if (null === versionizer._configHash) {
        const staticPath = utils.getStaticDir();
        const configTagFileName = path.join(staticPath, 'confighash');
        // See https://github.com/Haufe-Lexware/wicked.haufe.io/issues/190
        const hashOptions = {
            folders: {
                exclude: ['.git']
            }
        };
        folderHash.hashElement('.', staticPath, hashOptions, (err, configHash) => {
            if (err) {
                return callback(err);
            }
            // See https://github.com/marc136/node-folder-hash
            versionizer._configHash = configHash.hash;
            return callback(null, versionizer._configHash);
        });
    } else {
        return callback(null, versionizer._configHash);
    }
};

versionizer.writeConfigHashToMetadata = function (callback) {
    debug('writeConfigHashToMetadata()');
    dao.meta.setMetadata('config_hash', { hash: versionizer.getConfigHash() }, (err) => {
        dao.meta.getMetadata('config_hash', (err, persistedConfigHash) => {
            if (err) {
                return callback(err);
            }
            info(`Persisted config hash: ${persistedConfigHash.hash}`);
            return callback(null);
        });
    });
};

versionizer.getConfigHashMetadata = function (callback) {
    debug('getConfigHashMetadata()');
    dao.meta.getMetadata('config_hash', callback);
};

versionizer.getConfigHash = function () {
    if (!versionizer._configHash) {
        throw new Error('Config hash retrieved without being initialized.');
    }
    return versionizer._configHash;
};

versionizer.checkVersions = function (req, res, next) {
    debug('checkVersions()');
    // X-Config-Hash, User-Agent
    const configHash = req.get('x-config-hash');
    const userAgent = req.get('user-agent');
    if (configHash && !isConfigHashValid(req.app, configHash)) {
        debug('Invalid config hash: ' + configHash);
        return res.status(428).json({ message: 'Config Hash mismatch; restart client to retrieve new configuration' });
    }
    if (userAgent && !isUserAgentValid(userAgent)) {
        debug('Invalid user agent: ' + userAgent);
        return res.status(428).json({ message: 'Invalid client version; has to match API version (' + utils.getVersion() + ')' });
    }
    next();
};

function isConfigHashValid(app, configHash) {
    return (versionizer.getConfigHash() === configHash);
}

function isUserAgentValid(userAgent) {
    const slashIndex = userAgent.indexOf('/');
    if (slashIndex < 0) {
        return true;
    }
    const agentString = userAgent.substring(0, slashIndex);
    const versionString = userAgent.substring(slashIndex + 1).trim();

    // Only check versions for wicked clients.
    if (!agentString.startsWith('wicked')) {
        return true;
    }

    return (versionString === utils.getVersion());
}

module.exports = versionizer;
