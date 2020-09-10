const _ = require("lodash");
const semver = require("semver");
const { CONFIG, PRODUCER_STATE, DEFAULT_PRODUCER } = require("../../util/constants");
const { HTTPError } = require("../../util/error");

import {
  addProducerDB,
  getProducersDB,
  getProducerByGlobalIdDB,
  updateProducerDB,
  deleteProducerDB,
} from "../../dbController/Producer.ctrl";
const {
  validateProducerAndUpdateState,
  generateGlobalId,
} = require("../../util/utils");
// const logger = require("../../util/logger");

/**
 * Check an producer exist or not, if exist return this producer
 * @param {string} gid - Producer global ID
 * @param {string} securityKey - request security key if passed
 * @returns {Object} - producer
 */
async function checkProducerExistByGlobalID(gid, securityKey) {
  try {
    let producer = await getProducerByGlobalIdDB(gid, securityKey);
    // producer doesn't exist
    if (!producer) {
      throw new HTTPError(
        404,
        null,
        { globalId: gid },
        "00004040002",
        gid,
        securityKey
      );
    }
    return producer;
  } catch (err) {
    throw err;
  }
}

/**
 * Register an Producer to DIA.
 * Follow KISS principle, you need to make sure your **globalId** is unique.
 * Currently, **globalId** is only way for **Producer** Identity.
 * @param {object} Producer - Producer need to be register
 * @param {string} securityKey - The securityKey that previous service send, used to identify who send this request
 *
 * @returns {object}
 */
async function registerProducer(producer, securityKey) {
  try {
    // validate producer
    // TODO: change to validate based on schema
    if (!_.get(producer, "name")) {
      throw new HTTPError(400, null, {}, "00134000001");
    }

    // TODO: Think about whether we need to support Dynamic Generate **globalId**.
    // Comment 07/12/2019: after several time thinking, I think we should automatically generate **globalId**, so I comment this code.
    // Use globalId to find Producer.
    // let producerInDB = await findOneByGlobalId(
    //   COLLECTIONS_NAME.producers,
    //   producer.globalId,
    //   {
    //     projection: {
    //       globalId: 1
    //     }
    //   }
    // );
    // // globalId must be unique
    // if (producerInDB) {
    //   // globalId already exist
    //   throw new HTTPError(
    //     400,
    //     null,
    //     {
    //       globalId: producer.globalId
    //     },
    //     "00134000001",
    //     producer.globalId
    //   );
    // }

    // Delete globalId and _id, both of them should be generated by server side, don't allow user pass
    delete producer.globalId;
    delete producer._id;
    producer.globalId = generateGlobalId("producer");
    producer.type = _.toUpper(producer.type);
    // Before validate, default set producer state to DRAFT
    // producer.state = PRODUCER_STATE.draft;
    // when create an producer, default version is 1.0.0, the reason of 1.0.0 is because currently Producer Schema version is 1.0.0, make sure the main version is same with schema
    // producer.version = '1.0.0';
    producer = _.merge({}, DEFAULT_PRODUCER, producer);

    // if securityKey exist, then add securityKey to producer
    if (securityKey) {
      producer.system[CONFIG.SECURITY_KEY_IN_DB] = securityKey;
    }
    producer.system.created = Date.now();
    producer.system.modified = Date.now();
    producer.system.lastPing = null;
    // Validate producer, based on validate result to update producer state, don't allow user to direct change producer state
    producer = validateProducerAndUpdateState(producer);
    let result = await addProducerDB(producer);
    return result;
  } catch (err) {
    // Already HTTPError, then throw it
    throw err;
  }
}

/**
 * OperationIndex: 0002
 * Get a Producer by globalId
 * @param {string} gid - globalId
 *
 * @returns {object}
 */
async function getProducer(
  gid: string,
  securityKey: string,
  serialId: string,
  jobId: string,
  requestedWith: string,
  type: string
) {
  try {
    if (!gid) {
      throw new HTTPError(
        400,
        null,
        {
          globalId: gid,
        },
        "00144000001"
      );
    }
    let producer = await getProducerByGlobalIdDB(gid, securityKey);
    if (!producer) {
      throw new HTTPError(
        404,
        null,
        {
          globalId: gid,
        },
        "00144040001",
        gid
      );
    }

    if(type && (_.toUpper(producer.type) !== _.toUpper(type))){
      // if pass type, then need to make sure producer type is same with target producer type
      throw new HTTPError(
        400,
        null,
        {
          globalId: gid,
        },
        "00144000004",
        gid,
        type, 
        producer.type
      );
    }

    // console.log(
    //   `getProducer, gid: ${gid}, serialId: ${serialId}, jobId: ${jobId}`
    // );

    // If pass `serialId` and `serialId` isn't same with `producer.system.serialId`
    if (
      producer.system &&
      producer.system.serialId &&
      serialId &&
      producer.system.serialId != serialId
    ) {
      // This producer was connected
      throw new HTTPError(
        403,
        null,
        {
          globalId: gid,
        },
        "00144030001",
        gid
      );
    }

    let updateProducer: any = {
      system: {},
    };

    if (requestedWith !== CONFIG.REQUESTED_WITH_ENGINE_UI) {
      // if it isn't called by engine-ui then update last ping, otherwise don't need
      updateProducer.system.lastPing = Date.now();
    }

    if (type && serialId && !producer.system.serialId) {
      // need to update producer serialId, so this means producer was connected, before disconnect, don't allow connect
      // first producer connect to this
      // only user pass `type` and `serialId` then update serialId
      updateProducer.system.serialId = serialId;
    }

    await updateProducerDB(gid, securityKey, updateProducer);

    return producer;
  } catch (err) {
    throw err;
  }
}

/**
 * OperationIndex: 0010
 * Get a Producers
 * @param {string} securityKey - current user's security key
 *
 * @returns {object}
 */
async function getProducers(securityKey) {
  try {
    let producers = await getProducersDB(securityKey);
    return producers;
  } catch (err) {
    throw err;
  }
}

async function updateProducer(gid, producer, securityKey) {
  try {
    // Make sure can find Producer, if cannot, the it will throw 404 error
    let originalProducer = await checkProducerExistByGlobalID(gid, securityKey);

    // Remove cannot update fields
    delete producer._id;
    delete producer.id;
    delete producer.globalId;
    if (producer.system) {
      delete producer.system.created;
    }

    // let originalProducer = await getProducer(gid, securityKey);
    let obj = _.merge({}, originalProducer, producer);
    obj.system.modified = Date.now();

    // state before validation
    let producerState = obj.system.state;
    // Validate producer, based on validate result to update producer state, don't allow user to direct change producer state
    obj = validateProducerAndUpdateState(obj);

    // if producer state is **active** or **deleted**, then return error
    if (
      _.toUpper(obj.system.state) === _.toUpper(PRODUCER_STATE.active) ||
      _.toUpper(obj.system.state) === _.toUpper(PRODUCER_STATE.deleted)
    ) {
      throw new HTTPError(
        400,
        null,
        { globalId: obj.globalId, state: obj.system.state, name: obj.name },
        "00015400001",
        obj.system.state,
        obj.globalId
      );
    }

    // if state change, then we need to update minor version, otherwise only need to update patch version
    if (producerState !== obj.system.state) {
      // this means state change, then need to update minor
      obj.system.version = semver.inc(obj.system.version || "1.0.0", "minor");
    } else {
      obj.system.version = semver.inc(obj.system.version || "1.0.0", "patch");
    }

    // let result = await updateOne(
    //   COLLECTIONS_NAME.producers,
    //   {
    //     globalId: {
    //       $eq: gid
    //     }
    //   },
    //   {
    //     $set: obj
    //   }
    // );
    // return result;

    let result = await updateProducerDB(gid, securityKey, obj);
    return result;
  } catch (err) {
    throw err;
  }
}

/**
 * Disconnect an producer
 * 0017
 * @param {string} gid - producer globalId
 * @param {string} securityKey - current user's security key
 */
async function disconnectProducer(gid, securityKey, jobId) {
  try {
    let originalProducer: any = await checkProducerExistByGlobalID(gid, securityKey);

    // change state to **active**
    const version = semver.inc(
      originalProducer.system.version || "1.0.0",
      "major"
    );

    const updateProducer = {
      globalId: generateGlobalId("producer"),
      system: {
        serialId: "",
        version: version,
        lastPing: 0,
      },
    };

    await updateProducerDB(gid, securityKey, updateProducer);
    return {
      globalId: updateProducer.globalId,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Activate an producer
 * 0017
 * @param {string} gid - producer globalId
 * @param {string} securityKey - current user's security key
 */
async function activateProducer(gid, securityKey) {
  try {
    let originalProducer: any = await checkProducerExistByGlobalID(gid, securityKey);
    originalProducer = validateProducerAndUpdateState(originalProducer);

    // if it is draft state then throw an error
    if (originalProducer.system.state === PRODUCER_STATE.draft) {
      throw new HTTPError(400, null, { globalId: gid }, "0017400001");
    } else if (originalProducer.system.state === PRODUCER_STATE.deleted) {
      // **delete** then tell user cannot find, since we didn't show deleted producer in user's producer list
      throw new HTTPError(
        404,
        null,
        { globalId: gid },
        "00004040001",
        gid,
        securityKey
      );
    } else if (originalProducer.system.state === PRODUCER_STATE.active) {
      // If an producer's state is active, don't need to update it again
      return {
        state: originalProducer.system.state,
      };
    }

    // change state to **active**
    originalProducer.system.state = _.toUpper(PRODUCER_STATE.active);
    originalProducer.system.version = semver.inc(
      originalProducer.system.version || "1.0.0",
      "minor"
    );
    // let result = await updateOne(
    //   COLLECTIONS_NAME.producers,
    //   {
    //     globalId: {
    //       $eq: gid
    //     }
    //   },
    //   {
    //     $set: originalProducer
    //   }
    // );
    // return {
    //   state: originalProducer.system.state
    // };
    let result = await updateProducerDB(gid, securityKey, originalProducer);
    return {
      state: originalProducer.system.state,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Deactivate an producer
 * @param {string} gid
 * @param {string} securityKey
 */
async function deactivateProducer(gid, securityKey) {
  try {
    let originalProducer: any = await checkProducerExistByGlobalID(gid, securityKey);
    // originalProducer = validateProducerAndUpdateState(originalProducer);

    // if it is draft state then throw an error
    if (originalProducer.system.state === PRODUCER_STATE.draft) {
      throw new HTTPError(400, null, { globalId: gid }, "0018400001");
    } else if (originalProducer.system.state === PRODUCER_STATE.deleted) {
      // **delete** then tell user cannot find, since we didn't show deleted producer in user's producer list
      throw new HTTPError(
        404,
        null,
        { globalId: gid },
        "00004040001",
        gid,
        securityKey
      );
    } else if (originalProducer.system.state != PRODUCER_STATE.active) {
      // If an producer's state isn't active, don't need to update it again
      return {
        state: originalProducer.system.state,
      };
    }

    // change state to **configured**
    originalProducer.system.state = _.toUpper(PRODUCER_STATE.configured);
    originalProducer.system.version = semver.inc(
      originalProducer.system.version || "1.0.0",
      "minor"
    );
    // let result = await updateOne(
    //   COLLECTIONS_NAME.producers,
    //   {
    //     globalId: {
    //       $eq: gid
    //     }
    //   },
    //   {
    //     $set: originalProducer
    //   }
    // );
    // return {
    //   state: originalProducer.system.state
    // };
    let result = await updateProducerDB(gid, securityKey, originalProducer);
    return {
      state: originalProducer.system.state,
    };
  } catch (err) {
    throw err;
  }
}

async function unregisterProducer(gid: string, securityKey: string) {
  try {
    console.log("gid: ", gid, " securityKey: ", securityKey);
    // Make sure can find Producer, if cannot, the it will throw 404 error
    await checkProducerExistByGlobalID(gid, securityKey);
    let result = await deleteProducerDB(gid, securityKey);
    return result;
    // let query = {
    //   "producer.globalId": {
    //     $eq: gid
    //   }
    // };

    // // if (securityKey) {
    // //   query[CONFIG.SECURITY_KEY_IN_DB] = {
    // //     $eq: securityKey
    // //   };
    // // }
    // // remove all intelligences that this producer created
    // await remove(COLLECTIONS_NAME.intelligences, {
    //   query
    // });

    // let producerQuery = {
    //   globalId: {
    //     $eq: gid
    //   }
    // };
    // if (securityKey) {
    //   producerQuery[`system.${CONFIG.SECURITY_KEY_IN_DB}`] = {
    //     $eq: securityKey
    //   };
    // }

    // // remove this Producer in producers collection
    // let result = await remove(COLLECTIONS_NAME.producers, producerQuery);
    // return result;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  registerProducer,
  getProducer,
  updateProducer,
  unregisterProducer,
  activateProducer,
  deactivateProducer,
  disconnectProducer,
  getProducers,
};
