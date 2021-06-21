'use strict';


exports.handler = (event, context, callback) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;

    // fetch the uri of original image
    let fwdUri = request.uri;

    // read the accept header to determine if webP is supported.
    let accept = headers['accept'] ? headers['accept'][0].value : "";

    let prefix = !!accept.includes('webp') ? '/webp' : '/original';

    request.uri = prefix + fwdUri;
    callback(null, request);
};