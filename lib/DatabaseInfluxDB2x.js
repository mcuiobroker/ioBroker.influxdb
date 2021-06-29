'use strict';

const Database = require('./Database.js');
const InfluxClient = require('@influxdata/influxdb-client');
const InfluxClientApis =  require('@influxdata/influxdb-client-apis');

/* Old node-influx lib had some connection-pool handling that is not present in new influx lib,
   so to not break old code we use a fictional pool here. */
class FakeConnectionPool {
    constructor() {
        this.connections = [];
    }

    activatePool() {
        this.connections.push("fakehost");
    }

    getHostsAvailable() {
        return this.connections;
    }
}

//Influx 2.x auth requires token, not user/pw
class DatabaseInfluxDB2x extends Database{
    constructor (log, host, port, protocol, token, organization, database, timePrecision, requestTimeout) {
        super();

        this.log = log;

        this.host = host;
        this.port = port;
        this.protocol = protocol;
        this.token = token;
        this.organization = organization;
        this.database = database;
        this.timePrecision = timePrecision; // ms
        this.requestTimeout = requestTimeout; // 30000

        this.request = new FakeConnectionPool();

        this.connect();
    }

    connect () {
        const url = this.protocol + '://' + this.host + ':' + this.port + '/';

        this.connection = new InfluxClient.InfluxDB({
            url:     url,
            token:   this.token,
        });

        this.queryApi = this.connection.getQueryApi(this.organization);
        this.writeApi = this.connection.getWriteApi(this.organization, this.database, this.timePrecision);

        this.bucketsApi = new InfluxClientApis.BucketsAPI(this.connection);
        this.orgsApi = new InfluxClientApis.OrgsAPI(this.connection);
        this.healthApi = new InfluxClientApis.HealthAPI(this.connection);

        this.bucketIds = [];

        this.request.activatePool();
    }

    async getDatabaseNames (callback) {
        this.log.debug("Organization being checked: " + this.organization);

        try {
            const organizations = await this.orgsApi.getOrgs({org: this.organization});
            this.log.debug("Organizations: " + JSON.stringify(organizations));
            this.organizationId = organizations.orgs[0].id;

            const buckets = await this.bucketsApi.getBuckets({orgID: this.organizationId});
            this.log.debug("Buckets: " + JSON.stringify(buckets));

            const foundDatabases = [];

            buckets.buckets.forEach((bucket) => {
                foundDatabases.push(bucket.name);
                this.bucketIds[bucket.name] = bucket.id;
            });

            callback(null, foundDatabases)
        } catch (error) {
            callback(error, null);
        }
    }

    async createRetentionPolicyForDB(dbname, retention, callback_error) {
        this.log.info("Updating retention policy for " + dbname + " to " + retention + " seconds");
        try {
            await this.bucketsApi.patchBucketsID({
                bucketID: this.bucketIds[dbname],
                body: {
                    retentionRules: [{
                        type: "expire",
                        everySeconds: parseInt(retention),
                        shardGroupDurationSeconds: 0
                    }]
                }
            });
            callback_error(false);
        } catch (error) {
            this.log.error(error);
            callback_error(true);
        }
    }

    async createDatabase(dbname, callback_error) {
        try {
            this.log.info("Creating database " + dbname + " for orgId " + this.organizationId);
            const newBucket = await this.bucketsApi.postBuckets({ body: {
                orgID: this.organizationId,
                name: dbname
            }});

            this.bucketIds[dbname] = newBucket.id;
            callback_error(false);
        } catch (error) {
            this.log.error(error);
            callback_error(true);
        }
    }

    async dropDatabase(dbname, callback_error) {
        try {
            this.log.info("Dropping database " + dbname + " for orgId " + this.organizationId);
             await this.bucketsApi.deleteBucketsID({ body: {
                bucketID: this.bucketIds[dbname]
            }});
            delete this.bucketIds[dbname];
            callback_error(false);
        } catch (error) {
            this.log.error(error);
            callback_error(true);
        }
    }

    async writeSeries(series, callback_error) {
        this.log.debug("Write series: " + JSON.stringify(series));
        
        const points = [];
        for (const [pointId, valueSets] of Object.entries(series)) {
            valueSets.forEach((values) => {
                points.push(this.stateValueToPoint(pointId, values));
            });
        }

        try {
            this.writeApi.writePoints(points);
            await this.writeApi.flush();
            this.log.debug("Points written");
            callback_error();
        } catch (error) {
            callback_error(error);
        }
    }

    async writePoints(pointId, pointsToSend, callback_error) {
        this.log.debug("Write Points: SeriesId:"+seriesId+" pointstoSend:"+JSON.stringify(pointsToSend));
 
        const points = [];
        pointsToSend.forEach((values) => {
            points.push(this.stateValueToPoint(pointId, values));
        });

        try {
            this.writeApi.writePoints(points);
            await this.writeApi.flush();
            this.log.debug("Points written");
            callback_error();
        } catch (error) {
            callback_error(error);
        }
    }

    async writePoint(pointId, values, options, callback_error) {
        this.log.debug("Write Point: "+pointId+" values:"+ JSON.stringify(values) + " options: " + JSON.stringify(options));

        try {
            this.writeApi.writePoint(this.stateValueToPoint(pointId, values));
            await this.writeApi.flush();
            this.log.debug("Point written");
            callback_error();
        } catch (error) {
            callback_error(error);
        }

    }

    stateValueToPoint(pointName, stateValue){
        const point = new InfluxClient.Point(pointName)
            .timestamp(stateValue.time)
            .tag("q", String(stateValue.q))
            .tag("ack", String(stateValue.ack))
            .tag("from", stateValue.from);
        
        switch(typeof stateValue.value){
            case "boolean":
                point.booleanField("value", stateValue.value);
                break;
            case "number":
                point.floatField("value", parseFloat(stateValue.value));
                break;
            case "string":
            default:
                point.stringField("value", stateValue.value);
                break;
        }

        return point;
    }
    
    query(query, callback) {
        this.log.debug("Query to execute: " + query);
        let rows = [];
        
        this.queryApi.queryRows(query, {
            next(row , tableMeta) {
                const fields = tableMeta.toObject(row);

                //Columns "_time" and "_value" are mapped to "time" and "value" for backwards compatibility
                if (fields["_time"] !== null)
                    fields["time"] = fields["_time"];
                if (fields["_value"] !== null)
                    fields["value"] = fields["_value"];

                rows.push(fields);
                
                // console.log(JSON.stringify(o, null, 2))
            },
            error(error) {
                callback(error, null);
            },
            complete() {
                callback(null, rows);

            }
        });
    }

    async queries(queries, callback) {    
        try {
            const collectedRows = [];

            for (const query of queries) {
                await new Promise ((resolve, reject) => {
                    this.query(query, (error, rows) => {
                        if (error)
                            reject(error);
                        else {
                            collectedRows.push(rows);
                            resolve();
                        }
                    });
                });
            }
            callback(null, collectedRows);
        } catch (error){
            this.log.warn("QUERY ERROR: " + JSON.stringify(error));
            callback(error, null);
        }
        
        
    }

    ping(interval) {
        //can't do much with interval, so ignoring it for compatibility reasons
        const promises = [];
        promises.push(new Promise ((resolve, reject) => {
           this.healthApi.getHealth().then(result => {
                resolve(result.status === 'pass' ? {online: true} : {online: false});
           })
           .catch (error => {
                reject(error);
            });
        }));
        return Promise.all(promises);
    }
}

module.exports = {
    DatabaseInfluxDB2x : DatabaseInfluxDB2x
}