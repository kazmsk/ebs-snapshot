'use strict';

//definition library
const aws = require('aws-sdk');
const co = require('co');
const foreach = require('co-foreach');
const moment = require('moment');
const tz = require('moment-timezone');

//difinition variables
const ec2 = new aws.EC2();
const SNAPSHOT_GENERATION = 'Snapshot-Generation';

exports.handler = (event, context, callback) =>{
  console.log('start function');

  // event params
  console.log(JSON.stringify(event));

  // nametag date
  const date = moment().tz('Asia/Tokyo').format('YYYYMMDD');

  co(function* () {
    // check instance tag key
    console.log('check instance tag key');
    const reservations = yield describeInstance();
    if (reservations.length === 0) {
      console.log('instance none');
      return null;
    }

    // check instance tag value
    console.log('check instance tag value');
    const createReservations = checkTagValue(reservations);
    if (createReservations.length === 0) {
      console.log('instance none');
      return null;
    }

    // start create snapshot
    console.log('start create snapshot');
    yield foreach(createReservations, function *(reservation) {
      // create snapshot
      const snapshotId = yield createSnapshot(reservation);
      // create tag
      yield createTag(snapshotId, reservation);
    }).catch((error) => {
      throw error;
    });
    console.log('finish create snapshot');

    // check deletion
    console.log('check deletion target');
    const deleteReservations = getDeleteReservations(reservations);
    if (deleteReservations.length === 0) {
      console.log('instance none');
      return null;
    }

    // start delete snapshot
    console.log('start delete snapshot');
    yield foreach(deleteReservations, function *(reservation) {
      // snapshot list
      const snapshotList = yield describeSnapshot(reservation);

      // sort snapshot
      sortSnapshotList(snapshotList);

      // snapshot id list
      const snapshotIdList = getSnapshotIdList(reservation, snapshotList);
      if (snapshotIdList.length !== 0) {
        yield foreach(snapshotIdList, function *(snapshotId) {
          // delete snapshot
          yield deleteSnapshot(snapshotId);
        }).catch((error) => {
          throw error;
        });
      }
    }).catch((error) => {
      throw error;
    });
    console.log('finish delete snapshot');
    return null;
  }).then(onEnd).catch(onError);

  // check instance tag key
  function describeInstance() {
    return new Promise((resolve, reject) => {
      const params = {
        Filters: [
          {
            Name: 'tag-key',
            Values: [SNAPSHOT_GENERATION]
          }
        ]
      };
      ec2.describeInstances(params, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response.Reservations);
        }
      });
    });
  }

  // check instance tag value
  function checkTagValue(reservations) {
    const object = reservations.concat();
    reservations.forEach((reservation, index) => {
      const tagArray = reservation.Instances[0].Tags.filter((tag, index) => {
        if (tag.Key === SNAPSHOT_GENERATION) {
          return true;
        }
      });
      if (tagArray[0].Value === '' || tagArray[0].Value === '0') {
        delete object[index];
      }
    });
    return object;
  }

  // create snapshot
  function createSnapshot(reservation) {
    return new Promise((resolve, reject) => {
      const volumeId = reservation.Instances[0].BlockDeviceMappings[0].Ebs.VolumeId;
      const description = 'Snapshot that was created from the volume ID ' + volumeId + '.';
      const params = {
          VolumeId: volumeId,
          Description: description
      };
      ec2.createSnapshot(params, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response.SnapshotId);
        }
      });
    });
  }

  // create tag
  function createTag(snapshotId, reservation) {
    return new Promise((resolve, reject) => {
      const tagArray = reservation.Instances[0].Tags.filter((tag, index) => {
        if (tag.Key === 'Name') {
          return true;
        }
      });
      const nameTag = tagArray[0].Value + '-' + date;
      const params = {
        Resources: [
          snapshotId
        ],
        Tags: [
          {
            Key: 'Name',
            Value: nameTag
          },
          {
            Key: 'Auto-Snapshot',
            Value: 'true'
          }
        ]
      };
      ec2.createTags(params, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(null);
        }
      });
    });
  }

  // check instance
  function getDeleteReservations(reservations) {
    const object = reservations.concat();
    reservations.forEach((reservation, index) => {
      const tagArray = reservation.Instances[0].Tags.filter((tag, index) => {
        if (tag.Key === SNAPSHOT_GENERATION) {
          return true;
        }
      });
      if (tagArray[0].Value === '') {
        delete object[index];
      }
    });
    return object;
  }

  // check snapshot
  function describeSnapshot(reservation) {
    return new Promise((resolve, reject) => {
      const volumeId = reservation.Instances[0].BlockDeviceMappings[0].Ebs.VolumeId;
      const params = {
          Filters: [
            {
              Name: 'volume-id',
              Values: [volumeId]
            },
            {
              Name: 'tag:Auto-Snapshot',
              Values: ['true']
            }
          ]
      };
      ec2.describeSnapshots(params, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response.Snapshots);
        }
      });
    });
  }

  // sort snapshot
  function sortSnapshotList(snapshotList) {
    snapshotList.sort((first, second) => {
      return (first.StartTime > second.StartTime ? 1 : -1);
    });
  }

  // get snapshot id list
  function getSnapshotIdList(reservation, snapshotList) {
    const tagArray = reservation.Instances[0].Tags.filter((tag, index) => {
      if (tag.Key === SNAPSHOT_GENERATION) {
        return true;
      }
    });
    const deleteNumber = - (tagArray[0].Value - snapshotList.length);
    const snapshotIdList = [];
    for (let i = 0; i < deleteNumber; i++) {
      snapshotIdList.push(snapshotList[i].SnapshotId);
    }
    return snapshotIdList;
  }

  // delete snapshot
  function deleteSnapshot(snapshotId) {
    return new Promise((resolve, reject) => {
      const params = {
        SnapshotId: snapshotId
      };
      ec2.deleteSnapshot(params, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(null);
        }
      });
    });
  }

  // end
  function onEnd() {
    console.log('finish function');
    callback(null, 'succeed');
  }

  // error
  function onError(error) {
    console.log(error, error.stack);
    callback(error, error.stack);
  }
};