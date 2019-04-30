const jobNames = require('../jobNames');
const {
    COLLECTIONS_NAME
} = require('../../../util/constants');
const {
    find
} = require('../../../util/db');
const {updateSOIStatus} = require('../../sois/helpers');
const config = require('../../../config');
const logger = require('../../../util/logger');

module.exports = function (agenda) {
    agenda.define(jobNames.checkSOIStatus, async (job, done) => {
        try{
            // Get All SOIs
            // TODO: need to think about if you have million SOIs so you don't want to get all SOIs
            // for now assume sois doesn't too big
            let sois = await find(COLLECTIONS_NAME.sois, {
                modified_at:{
                    $lt: (Date.now()-config.SOI_STATUS_CHECK_TIME)
                }
            });

            // TODO: This need to improve, it shouldn't check one by one, it should check multiple together
            for(let i=0; i<sois.length; i++){
                await updateSOIStatus(sois[i].global_id, sois[i]);
            }
            done();
        }catch(err){
            logger.error(err);
        }
    });
};