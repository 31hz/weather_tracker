'use latest';
import bodyParser from 'body-parser';
import express from 'express';
import Webtask from 'webtask-tools';
import { MongoClient } from 'mongodb';
import http from 'http';

const COLLECTION = 'clients';
const MYDB = 'mattdb1';
const WEATHER_ROOT = 'http://api.openweathermap.org/data/2.5/weather?';
const PAGE_REFRESH_S = 120;

const server = express();

// Inject the body parsing middleware
server.use(bodyParser.json());

/* DRY factor out Mongo connection
   mongoUrl: URL of the Mongo instance
   next: callback to call if error
   cb(client): callback to call on success
   calls the callback with the new Mongo client */

var doMongoConnect = function(mongoUrl, next, cb) {
  MongoClient.connect(mongoUrl, (err, client) => {

    if (err) return next(err);

    // success
    cb(client);
  });
  return null;
};


/* retrieve some records from mongo
   db is the database handle
   the filter parameter will be passed to
   collection.find() to choose specific records,
   or may be set to true to return all records 
   cb is the success callback to be called with 
   the results cb(items) */

var retrieve = function (db, filter, cb) {
  let col = db.collection(COLLECTION);
  col.find(filter).toArray( (err, items) => {
      if (err) throw err;
      cb(items);
  });
};

/* perform an http query to retrieve weather data for a
   single zip code.
   client: already-connected DB handle
   zip: the zip code to query
   apiKey: the API key for the weather API
   upon success, all Mongo records matching the zip code
   will be updated with a new response payload and a
   timestamp of when the update occurred.*/
var queryOneZip = function (client, zip, apiKey) {

  // setup http request
  console.log(`start request for ${zip}`);
  let fullUrl = `${WEATHER_ROOT}APPID=${apiKey}&zip=${zip}`;
  let payload = '';
  http.get(fullUrl, (wres) => {

    wres.on('data', (chunk) => {
      payload += chunk;
    });

    wres.on('end', () => {
      if (wres.statusCode === 200) {
        console.log(payload);

        // now update the db
        client.db(MYDB).collection(COLLECTION).update(
        {zip: zip},
        { '$set': {cron_update: payload, cron_time_ms: (new Date()).getTime()}},
        {upsert: false, multi: true},
        (error, result) => {
          if (error) {
            console.log(error);
          } else {
            console.log(`updating ${zip} OK`);
          }
          return null;
       });
      }
    });
  });
};

/* run the periodic query to gather temperature */
server.post('/', (req, res, next) => {
  console.log('cron task executed');
  const { MONGO_URL } = req.webtaskContext.secrets;
  const { WEATHER_APIKEY} = req.webtaskContext.secrets;
  doMongoConnect(MONGO_URL, next, client => {
      retrieve(client.db(MYDB), true, (items) => {
      console.log(`total cron items: ${items.length}`);

      // get unique items
      let uniqueMap = {};
      for (let i = 0; i < items.length; i++) {
        uniqueMap[items[i].zip] = true;
      }

      let uniqueKeyArray = Object.keys(uniqueMap);
      console.log(`total unique cron items: ${uniqueKeyArray.length}`);

      // queue http requests
      for (let i = 0; i < uniqueKeyArray.length; i++) {
        queryOneZip(client, uniqueKeyArray[i], WEATHER_APIKEY);
      }

      res.send('Finished queueing updates');
    });
  });
});

/* default get from root
  This will return the HTML view of all the
  weather results */
server.get('/', (req, res, next) => {

  // First, collect all of the results from Mongo
  const { MONGO_URL } = req.webtaskContext.secrets;
  doMongoConnect(MONGO_URL, next, client => {
      retrieve(client.db(MYDB), true, (items) => {
      client.close();
      console.log(`view: retrieved ${items.length} items`);

      res.set('Content-Type', 'text/html');
      res.send(composeHtml(items));
    });
  });
});

/* server list all clients */
server.get('/clients', (req, res, next) => {
  const { MONGO_URL } = req.webtaskContext.secrets;
  doMongoConnect(MONGO_URL, next, client => {
    console.log('get all: mongo opened ok');
      retrieve(client.db(MYDB), true, (items) => {
      client.close();
      console.log('get all items:');
      console.log(items);
      console.log('get all: completed');
      res.send(items);
    });
  });
});

/* server get a specific record */
server.get('/clients/:name', (req, res, next) => {
  const { MONGO_URL } = req.webtaskContext.secrets;
  const { name } = req.params;

  doMongoConnect(MONGO_URL, next, client => {
    console.log('get single: mongo opened ok');

      retrieve(client.db(MYDB), {name: name}, (items) => {
      client.close();
      if (items.length === 0) {
        res.status(404).send('{"errors":[{"status":"404","detail": "Client name not found"}]}');
      } else {
        res.send(items);
      }
    });
  });
});

/* server delete a specific record */
server.delete('/clients/:name', (req, res, next) => {
  const { MONGO_URL } = req.webtaskContext.secrets;
  const { name } = req.params;

  doMongoConnect(MONGO_URL, next, client => {
    console.log('del single: mongo opened ok');

      client.db(MYDB).collection(COLLECTION).remove(
        {name: name},
        false,
        (err, result) => {
          if (err) {
            next(err);
          } else {
            //TODO: parse result to see if a record was deleted or not
            //res.status(404).send('{"errors":[{"status":"404","detail": "Client name not found"}]}');
            res.status(200).send('');
          }
        }
      );
  });
});

/* add or update a client to the client list
   The following fields are used:
   'name' is a unique index and the primary identifier
   posting with an existing name will cause an update.
   'zip' is the desired zipcode
*/

server.post('/clients', (req, res, next) => {
  const { MONGO_URL } = req.webtaskContext.secrets;
  const model = req.body;

  if (model.name && model.zip) {
    doMongoConnect(MONGO_URL, next, client => {

        client.db(MYDB).collection(COLLECTION).replaceOne(
          {name: model.name},
          model,
          {upsert: true},
          (error, result) => {
            client.close();
            if (error) return next(error);
            res.status(200).send(`/clients/${model.name}`);
            return null;
        });
    });
  } else {
    res.status(400).send('{"errors":[{"status":"400","detail": "Missing parameters"}]}');
  }
});

/* Compose the HTML output
  items: the array of all results from the DB */
var composeHtml = function (items) {
  let result = '<!DOCTYPE HTML><html>';

  // add the head
  result += `<head><meta charset="utf-8"><meta http-equiv="refresh" content="${PAGE_REFRESH_S}"><title>Requested Weather Zipcodes</title></head>`;

  // add the body
  result += '<body><table cellspacing="30">';

  // table header
  result += '<tr><th>Requestor</th><th>Zip</th><th>Location</th><th>Temp F</th><th>Last Updated UTC</th></tr>';

  // add the rows
  for (let i = 0; i < items.length; i++) {
    result += composeOneRow(items[i]);
  }
  // finish
  result += '</table></body>';
  result += '</html>';
  return result;
};

/* Compose a single table row
  oneItem: a single entry from the DB */

var composeOneRow = function(oneItem) {
  let result = '<tr>';

  // requestor
  result += `<td>${oneItem.name}</td>`;

  // zip
  result += `<td>${oneItem.zip}</td>`;

  // Has there been a result collected?
  if (oneItem.cron_update) {
    let cronObj = JSON.parse(oneItem.cron_update); // convert JSON to object
    let tempF = convertKtoF(cronObj.main.temp);
    let utcDate = (new Date(oneItem.cron_time_ms)).toLocaleString();

    // location
    result += `<td>${cronObj.name}</td>`;

    // Temp F
    result += `<td>${tempF}</td>`;

    // Last updated
    result += `<td>${utcDate}</td>`;

  } else {
    // This item is new, no data yet
    result += '<td>n/a</td><td>n/a</td><td>n/a</td>';
  }

  result += '</tr>';
  return result;
};

/* Convert temp kelvin to temp F
  round to one decimal place */
var convertKtoF = function(tempK) {
  return (((tempK - 273.15) * 1.8) + 32).toFixed(1);
};

module.exports = Webtask.fromExpress(server);

