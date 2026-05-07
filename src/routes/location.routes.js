const express = require('express');
const router = express.Router();

const { getProvinces, getDistrictsByProvince, getWardsByDistrict } = require('../controllers/location.controller');

router.get('/provinces', getProvinces);
router.get('/provinces/:provinceId/districts', getDistrictsByProvince);
router.get('/districts/:districtId/wards', getWardsByDistrict);

module.exports = router;