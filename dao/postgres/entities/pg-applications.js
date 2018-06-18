'use strict';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('portal-api:dao:pg:applications');

const utils = require('../../../routes/utils');
const ownerRoles = require('../../../routes/ownerRoles');

class PgApplications {
    constructor(pgUtils) {
        this.pgUtils = pgUtils;
    }

    // =================================================
    // DAO contract
    // =================================================

    getById(appId, callback) {
        debug('getById()');
        this.pgUtils.checkCallback(callback);
        return this.getByIdImpl(appId, null, callback);
    }

    create(appCreateInfo, userInfo, callback) {
        debug('create()');
        this.pgUtils.checkCallback(callback);
        return this.createImpl(appCreateInfo, userInfo, callback);
    }

    save(appInfo, savingUserId, callback) {
        debug('save()');
        this.pgUtils.checkCallback(callback);
        return this.saveImpl(appInfo, savingUserId, callback);
    }

    delete(appId, deletingUserId, callback) {
        debug(`delete(${appId})`);
        this.pgUtils.checkCallback(callback);
        // Postgres will do all the cascading deleting on owners, and the index
        // is of course also managed by Postgres.
        return this.pgUtils.deleteById('applications', appId, callback);
    }

    getAll(filter, orderBy, offset, limit, noCountCache, callback) {
        debug('getAll()');
        this.pgUtils.checkCallback(callback);
        return this.getAllImpl(filter, orderBy, offset, limit, noCountCache, callback);
    }

    getIndex(offset, limit, callback) {
        debug('getIndex()');
        this.pgUtils.checkCallback(callback);
        return this.getIndexImpl(offset, limit, callback);
    }

    getCount(callback) {
        debug('getCount()');
        this.pgUtils.checkCallback(callback);
        return this.pgUtils.count('applications', callback);
    }

    getOwners(appId, callback) {
        debug('getOwners()');
        this.pgUtils.checkCallback(callback);
        return this.getOwnersImpl(appId, null, callback);
    }

    addOwner(appId, userInfo, role, addingUserId, callback) {
        debug('addOwner()');
        this.pgUtils.checkCallback(callback);
        return this.addOwnerImpl(appId, userInfo, role, addingUserId, callback);
    }

    deleteOwner(appId, deleteUserId, deletingUserId, callback) {
        debug('deleteOwner()');
        this.pgUtils.checkCallback(callback);
        return this.deleteOwnerImpl(appId, deleteUserId, deletingUserId, callback);
    }

    // =================================================
    // DAO implementation/internal methods
    // =================================================

    getByIdImpl(appId, client, callback) {
        debug(`getByIdImpl(${appId})`);
        const options = client ? { client: client } : null;
        // First load the basic app information
        const instance = this;
        this.pgUtils.getById('applications', appId, options, (err, appInfo) => {
            if (err)
                return callback(err);
            if (!appInfo)
                return callback(null, null);
            // Then load the owners, so that we can add them
            instance.getOwnersImpl(appId, client, (err, ownerList) => {
                if (err)
                    return callback(err);
                appInfo.owners = ownerList;
                return callback(null, appInfo);
            });
        });
    }

    createImpl(appCreateInfo, userInfo, callback) {
        debug('createImpl()');
        const appId = appCreateInfo.id.trim();

        const instance = this;
        // Check for Dupe
        this.pgUtils.getById('applications', appId, (err, existingApp) => {
            if (err)
                return callback(err);
            if (existingApp)
                return callback(utils.makeError(409, 'Application ID "' + appId + '" already exists.'));
            // Now we can add the application
            const newApp = {
                id: appId,
                name: appCreateInfo.name.substring(0, 128),
                redirectUri: appCreateInfo.redirectUri,
                confidential: !!appCreateInfo.confidential,
                mainUrl: appCreateInfo.mainUrl
            };
            const ownerInfo = PgApplications.makeOwnerInfo(appId, userInfo, ownerRoles.OWNER);

            let createdAppInfo = null;
            // Use a transaction so that the state will remain consistent
            instance.pgUtils.withTransaction((err, client, callback) => {
                if (err)
                    return callback(err);
                async.series({
                    // Create the application
                    createApp: callback => instance.pgUtils.upsert('applications', newApp, userInfo.id, client, callback),
                    // ... and add an owner record for the current user for it
                    createOwner: callback => instance.pgUtils.upsert('owners', ownerInfo, userInfo.id, client, callback),
                    // And reload the structure to get what the DAO contract wants
                    getApp: callback => instance.getByIdImpl(appId, client, callback)
                }, (err, results) => {
                    if (err)
                        return callback(err);
                    debug('createImpl: Successfully created application');
                    // We want to return this, so we need to save it from here and pass it
                    // back to the calling function from below. This callback is the callback
                    // from the withTransaction function, which swallows any return results.
                    createdAppInfo = results.getApp;
                    return callback(null);
                });
            }, (err) => {
                if (err)
                    return callback(err);
                debug('Created application info:');
                debug(createdAppInfo);
                return callback(null, createdAppInfo);
            });
        });
    }

    saveImpl(appInfo, savingUserId, callback) {
        debug('saveImpl()');
        const tempApp = Object.assign({}, appInfo);
        if (tempApp.owners)
            delete tempApp.owners;
        this.pgUtils.upsert('applications', appInfo, savingUserId, (err) => {
            if (err)
                return callback(err);
            return callback(null, appInfo);
        });
    }

    getAllImpl(filter, orderBy, offset, limit, noCountCache, callback) {
        debug(`getAll(filter: ${filter}, orderBy: ${orderBy}, offset: ${offset}, limit: ${limit})`);
        //return callback(new Error('PG.getAllImpl: Not implemented.'));
        const fields = [];
        const values = [];
        const operators = [];
        this.pgUtils.addFilterOptions(filter, fields, values, operators);
        // This may be one of the most complicated queries we have here...
        const options = {
            limit: limit,
            offset: offset,
            orderBy: orderBy ? orderBy : 'id ASC',
            operators: operators,
            noCountCache: noCountCache,
            additionalFields: ', b.users_id AS owner_user_id, b.data->>\'email\' AS owner_email',
            joinClause: 'LEFT JOIN wicked.owners b ON a.id = b.applications_id AND b.id = (SELECT id FROM wicked.owners c WHERE c.applications_id = a.id AND c.data->>\'role\' = \'owner\' LIMIT 1)'
        };
        return this.pgUtils.getBy('applications', fields, values, options, (err, rows, countResult) => {
            if (err)
                return callback(err);
            // Map owner_user_id and owner_email to nicer properties
            for (let i = 0; i < rows.length; ++i) {
                rows[i].ownerUserId = rows[i].owner_user_id;
                delete rows[i].owner_user_id;
                rows[i].ownerEmail = rows[i].owner_email;
                delete rows[i].owner_email;
            }
            return callback(null, rows, countResult);
        });
    }

    getIndexImpl(offset, limit, callback) {
        debug(`getIndex(offset: ${offset}, limit: ${limit})`);
        this.pgUtils.getBy('applications', [], [], { orderBy: 'id ASC' }, (err, appList, countResult) => {
            if (err)
                return callback(err);
            const appIdList = appList.map(app => { return { id: app.id }; });
            return callback(null, appIdList, countResult);
        });
    }

    getOwnersImpl(appId, client, callback) {
        debug(`getOwners(${appId})`);
        const options = client ? { client: client } : null;
        this.pgUtils.getBy('owners', ['applications_id'], [appId], options, (err, ownerList) => {
            if (err)
                return callback(err);
            const owners = ownerList.map(owner => {
                // Strip the index fields, not needed here
                return {
                    userId: owner.userId,
                    role: owner.role,
                    email: owner.email
                };
            });
            debug(ownerList);
            debug(owners);
            return callback(null, owners);
        });
    }

    addOwnerImpl(appId, userInfo, role, addingUserId, callback) {
        debug(`addOwnerImpl(${appId}, ${userInfo.id}, role: ${role})`);
        const ownerInfo = PgApplications.makeOwnerInfo(appId, userInfo, role);
        const instance = this;
        this.pgUtils.upsert('owners', ownerInfo, addingUserId, (err) => {
            if (err)
                return callback(err);
            // Return the appInfo as a result
            return this.getByIdImpl(appId, null, callback);
        });
    }

    deleteOwnerImpl(appId, deleteUserId, deletingUserId, callback) {
        debug(`deleteOwnerImpl(${appId}, ${deleteUserId}`);
        const instance = this;
        this.pgUtils.deleteBy('owners', ['appId', 'userId'], [appId, deleteUserId], (err) => {
            if (err)
                return callback(err);
            // Return the updated appInfo as a result
            return this.getByIdImpl(appId, null, callback);
        });
    }

    static makeOwnerInfo(appId, userInfo, role) {
        return {
            id: utils.createRandomId(),
            appId: appId,
            userId: userInfo.id,
            role: role,
            email: userInfo.email
        };
    }

}

module.exports = PgApplications;
