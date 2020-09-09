const _ = require("lodash");
const semver = require("semver");
const { CONFIG, AGENT_STATE, DEFAULT_AGENT } = require("../../util/constants");
const { HTTPError } = require("../../util/error");

import {
  addAgentDB,
  getAgentsDB,
  getAgentByGlobalIdDB,
  updateAgentDB,
  deleteAgentDB,
} from "../../dbController/Agent.ctrl";
const {
  validateAgentAndUpdateState,
  generateGlobalId,
} = require("../../util/utils");
// const logger = require("../../util/logger");

/**
 * Check an producer exist or not, if exist return this producer
 * @param {string} gid - Agent global ID
 * @param {string} securityKey - request security key if passed
 * @returns {Object} - producer
 */
async function checkAgentExistByGlobalID(gid, securityKey) {
  try {
    let producer = await getAgentByGlobalIdDB(gid, securityKey);
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
 * Register an Agent to DIA.
 * Follow KISS principle, you need to make sure your **globalId** is unique.
 * Currently, **globalId** is only way for **Agent** Identity.
 * @param {object} Agent - Agent need to be register
 * @param {string} securityKey - The securityKey that previous service send, used to identify who send this request
 *
 * @returns {object}
 */
async function registerAgent(producer, securityKey) {
  try {
    // validate producer
    // TODO: change to validate based on schema
    if (!_.get(producer, "name")) {
      throw new HTTPError(400, null, {}, "00134000001");
    }

    // TODO: Think about whether we need to support Dynamic Generate **globalId**.
    // Comment 07/12/2019: after several time thinking, I think we should automatically generate **globalId**, so I comment this code.
    // Use globalId to find Agent.
    // let agentInDB = await findOneByGlobalId(
    //   COLLECTIONS_NAME.agents,
    //   producer.globalId,
    //   {
    //     projection: {
    //       globalId: 1
    //     }
    //   }
    // );
    // // globalId must be unique
    // if (agentInDB) {
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
    // producer.state = AGENT_STATE.draft;
    // when create an producer, default version is 1.0.0, the reason of 1.0.0 is because currently Agent Schema version is 1.0.0, make sure the main version is same with schema
    // producer.version = '1.0.0';
    producer = _.merge({}, DEFAULT_AGENT, producer);

    // if securityKey exist, then add securityKey to producer
    if (securityKey) {
      producer.system[CONFIG.SECURITY_KEY_IN_DB] = securityKey;
    }
    producer.system.created = Date.now();
    producer.system.modified = Date.now();
    producer.system.lastPing = null;
    // Validate producer, based on validate result to update producer state, don't allow user to direct change producer state
    producer = validateAgentAndUpdateState(producer);
    let result = await addAgentDB(producer);
    return result;
  } catch (err) {
    // Already HTTPError, then throw it
    throw err;
  }
}

/**
 * OperationIndex: 0002
 * Get a Agent by globalId
 * @param {string} gid - globalId
 *
 * @returns {object}
 */
async function getAgent(
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
    let producer = await getAgentByGlobalIdDB(gid, securityKey);
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
    //   `getAgent, gid: ${gid}, serialId: ${serialId}, jobId: ${jobId}`
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

    let updateAgent: any = {
      system: {},
    };

    if (requestedWith !== CONFIG.REQUESTED_WITH_ENGINE_UI) {
      // if it isn't called by engine-ui then update last ping, otherwise don't need
      updateAgent.system.lastPing = Date.now();
    }

    if (type && serialId && !producer.system.serialId) {
      // need to update producer serialId, so this means producer was connected, before disconnect, don't allow connect
      // first producer connect to this
      // only user pass `type` and `serialId` then update serialId
      updateAgent.system.serialId = serialId;
    }

    await updateAgentDB(gid, securityKey, updateAgent);

    return producer;
  } catch (err) {
    throw err;
  }
}

/**
 * OperationIndex: 0010
 * Get a Agents
 * @param {string} securityKey - current user's security key
 *
 * @returns {object}
 */
async function getAgents(securityKey) {
  try {
    let agents = await getAgentsDB(securityKey);
    return agents;
  } catch (err) {
    throw err;
  }
}

async function updateAgent(gid, producer, securityKey) {
  try {
    // Make sure can find Agent, if cannot, the it will throw 404 error
    let originalAgent = await checkAgentExistByGlobalID(gid, securityKey);

    // Remove cannot update fields
    delete producer._id;
    delete producer.id;
    delete producer.globalId;
    if (producer.system) {
      delete producer.system.created;
    }

    // let originalAgent = await getAgent(gid, securityKey);
    let obj = _.merge({}, originalAgent, producer);
    obj.system.modified = Date.now();

    // state before validation
    let agentState = obj.system.state;
    // Validate producer, based on validate result to update producer state, don't allow user to direct change producer state
    obj = validateAgentAndUpdateState(obj);

    // if producer state is **active** or **deleted**, then return error
    if (
      _.toUpper(obj.system.state) === _.toUpper(AGENT_STATE.active) ||
      _.toUpper(obj.system.state) === _.toUpper(AGENT_STATE.deleted)
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
    if (agentState !== obj.system.state) {
      // this means state change, then need to update minor
      obj.system.version = semver.inc(obj.system.version || "1.0.0", "minor");
    } else {
      obj.system.version = semver.inc(obj.system.version || "1.0.0", "patch");
    }

    // let result = await updateOne(
    //   COLLECTIONS_NAME.agents,
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

    let result = await updateAgentDB(gid, securityKey, obj);
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
async function disconnectAgent(gid, securityKey, jobId) {
  try {
    let originalAgent: any = await checkAgentExistByGlobalID(gid, securityKey);

    // change state to **active**
    const version = semver.inc(
      originalAgent.system.version || "1.0.0",
      "major"
    );

    const updateAgent = {
      globalId: generateGlobalId("producer"),
      system: {
        serialId: "",
        version: version,
        lastPing: 0,
      },
    };

    await updateAgentDB(gid, securityKey, updateAgent);
    return {
      globalId: updateAgent.globalId,
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
async function activateAgent(gid, securityKey) {
  try {
    let originalAgent: any = await checkAgentExistByGlobalID(gid, securityKey);
    originalAgent = validateAgentAndUpdateState(originalAgent);

    // if it is draft state then throw an error
    if (originalAgent.system.state === AGENT_STATE.draft) {
      throw new HTTPError(400, null, { globalId: gid }, "0017400001");
    } else if (originalAgent.system.state === AGENT_STATE.deleted) {
      // **delete** then tell user cannot find, since we didn't show deleted producer in user's producer list
      throw new HTTPError(
        404,
        null,
        { globalId: gid },
        "00004040001",
        gid,
        securityKey
      );
    } else if (originalAgent.system.state === AGENT_STATE.active) {
      // If an producer's state is active, don't need to update it again
      return {
        state: originalAgent.system.state,
      };
    }

    // change state to **active**
    originalAgent.system.state = _.toUpper(AGENT_STATE.active);
    originalAgent.system.version = semver.inc(
      originalAgent.system.version || "1.0.0",
      "minor"
    );
    // let result = await updateOne(
    //   COLLECTIONS_NAME.agents,
    //   {
    //     globalId: {
    //       $eq: gid
    //     }
    //   },
    //   {
    //     $set: originalAgent
    //   }
    // );
    // return {
    //   state: originalAgent.system.state
    // };
    let result = await updateAgentDB(gid, securityKey, originalAgent);
    return {
      state: originalAgent.system.state,
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
async function deactivateAgent(gid, securityKey) {
  try {
    let originalAgent: any = await checkAgentExistByGlobalID(gid, securityKey);
    // originalAgent = validateAgentAndUpdateState(originalAgent);

    // if it is draft state then throw an error
    if (originalAgent.system.state === AGENT_STATE.draft) {
      throw new HTTPError(400, null, { globalId: gid }, "0018400001");
    } else if (originalAgent.system.state === AGENT_STATE.deleted) {
      // **delete** then tell user cannot find, since we didn't show deleted producer in user's producer list
      throw new HTTPError(
        404,
        null,
        { globalId: gid },
        "00004040001",
        gid,
        securityKey
      );
    } else if (originalAgent.system.state != AGENT_STATE.active) {
      // If an producer's state isn't active, don't need to update it again
      return {
        state: originalAgent.system.state,
      };
    }

    // change state to **configured**
    originalAgent.system.state = _.toUpper(AGENT_STATE.configured);
    originalAgent.system.version = semver.inc(
      originalAgent.system.version || "1.0.0",
      "minor"
    );
    // let result = await updateOne(
    //   COLLECTIONS_NAME.agents,
    //   {
    //     globalId: {
    //       $eq: gid
    //     }
    //   },
    //   {
    //     $set: originalAgent
    //   }
    // );
    // return {
    //   state: originalAgent.system.state
    // };
    let result = await updateAgentDB(gid, securityKey, originalAgent);
    return {
      state: originalAgent.system.state,
    };
  } catch (err) {
    throw err;
  }
}

async function unregisterAgent(gid: string, securityKey: string) {
  try {
    console.log("gid: ", gid, " securityKey: ", securityKey);
    // Make sure can find Agent, if cannot, the it will throw 404 error
    await checkAgentExistByGlobalID(gid, securityKey);
    let result = await deleteAgentDB(gid, securityKey);
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

    // let agentQuery = {
    //   globalId: {
    //     $eq: gid
    //   }
    // };
    // if (securityKey) {
    //   agentQuery[`system.${CONFIG.SECURITY_KEY_IN_DB}`] = {
    //     $eq: securityKey
    //   };
    // }

    // // remove this Agent in agents collection
    // let result = await remove(COLLECTIONS_NAME.agents, agentQuery);
    // return result;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  registerAgent,
  getAgent,
  updateAgent,
  unregisterAgent,
  activateAgent,
  deactivateAgent,
  disconnectAgent,
  getAgents,
};
