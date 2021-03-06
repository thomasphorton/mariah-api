const AWS = require('aws-sdk');

AWS.config.update({
  region: process.env.AWS_REGION
});

exports.list = function(req, res) {
  const docClient = new AWS.DynamoDB.DocumentClient();

  let params = {
    TableName: `${process.env.TRIPS_TABLE}`,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': '1'
    }
  };

  docClient.query(params, (err, data) => {
    if (err) {
      console.log("Unable to query. Error: ", JSON.stringify(err, null, 2));
      res.status(500).json({
        "err": err
      })
    } else {
      let trips = data.Items;

      trips.sort((a, b) => {
        return b.ts - a.ts;
      });

      res.status(200).json(trips);
    }
  })
}

exports.view = function(req, res) {
  var state = {
    tripId: req.params.tripId
  };

  // get trip data
  getTripData(state)

  // return trip data
  .then((state) => {
    res.status(200).json(state)
  })
}

function getTripData(state) {
  return new Promise((resolve, reject) => {
    const docClient = new AWS.DynamoDB.DocumentClient();

    var params = {
      TableName: `${process.env.TRIPS_TABLE}`,
      Key: {
        userId: '1',
        tripId: state.tripId
      }
    };

    docClient.get(params, (err, data) => {
      if (err) {
        console.log(err);
        reject(err);;
      } else {

        mergedState = Object.assign(state, data.Item);

        let timeSinceTripEnd = 0;

        // Calculate the time passed since the last datapoint and now.
        if (data.Item.tripEnd) {
          let now = new Date().getTime();
          timeSinceTripEnd = now - data.Item.tripEnd;
        }

        processTrip(mergedState)
          .then(state => {
            resolve(state);
          });

      }
    })

  })
}

function processTrip(state) {
  return new Promise((resolve, reject) => {
    createTripGeoJson(state)

    // upload file to s3
    .then(state => uploadGeoJson(state))

    // update trip table with pointer
    .then(state => updateTripData(state))

    .then(state => {
      resolve(state);
    });
  });
}

function createTripGeoJson(state) {
  return new Promise((resolve, reject) => {

    const docClient = new AWS.DynamoDB.DocumentClient();

    let geojson = {
      'type': 'LineString',
      'coordinates': []
    };

    var params = {
      TableName:  `${process.env.TRIP_DATA_TABLE}`,
      KeyConditionExpression: 'tripId = :trip_id',
      ExpressionAttributeValues: {
        ':trip_id': state.tripId
      }
    };

    docClient.query(params, (err, data) => {
      if (err) {
        console.error(JSON.stringify(err, null, 2));
        reject(err);
      } else {
        let coords = [];
        let sumLon = 0;
        let sumLat = 0;

        let tripEnd = 0;

        data.Items.forEach(item => {
          if (item.lon !== undefined && item.lat !== undefined) {

            sumLon += parseFloat(item.lon);
            sumLat += parseFloat(item.lat);
            coords.push([parseFloat(item.lon), parseFloat(item.lat)]);

            if (item.ts > tripEnd) {
              tripEnd = item.ts;
            }
          }
        });

        if (coords.length > 0) {
          state.geoJsonCenter = {
            lon: sumLon / coords.length,
            lat: sumLat / coords.length
          };
        } else {
          state.geoJsonCenter = {
            lon: 0,
            lat: 0
          };
        }

        geojson.coordinates = coords;
        state.tripEnd = tripEnd;
        state.geojson = geojson;
        state.lastProcessed = new Date().getTime();
        resolve(state);
      }
    });
  });
}

function uploadGeoJson(state) {
  return new Promise((resolve, reject) => {
    const s3 = new AWS.S3();

    let s3params = {
      Body: JSON.stringify(state.geojson),
      Bucket: 'mariah-us-west-2',
      Key: `${state.tripId}.json`,
      ACL: 'public-read'
    };

    s3.putObject(s3params, (err, data) => {
      if (err) {
        console.log(err, err.stack);
        reject(err);
      } else {
        let dataUrl = `https://s3-us-west-2.amazonaws.com/mariah-us-west-2/${state.tripId}.json`;
        state.dataUrl = dataUrl;
        delete state.geojson;
        resolve(state);
      }
    });
  });
}

function updateTripData(state) {
  return new Promise((resolve, reject) => {
    const docClient = new AWS.DynamoDB.DocumentClient();

    var params = {
      TableName: `${process.env.TRIPS_TABLE}`,
      Key: {
        userId: '1',
        tripId: state.tripId
      },
      AttributeUpdates: {
        'geoJsonUrl': {
          Action: 'PUT',
          Value: state.dataUrl
        },
        'geoJsonCenter': {
          Action: 'PUT',
          Value: state.geoJsonCenter
        },
        'lastProcessed': {
          Action: 'PUT',
          Value: state.lastProcessed
        },
        'tripEnd': {
          Action: 'PUT',
          Value: state.tripEnd
        }
      }
    };

    docClient.update(params, (err, data) => {
      if (err) {
        console.log("Unable to query. Error: ", JSON.stringify(err, null, 2));
        reject(err);
      } else {
        resolve(state);
      }
    })
  })
}
