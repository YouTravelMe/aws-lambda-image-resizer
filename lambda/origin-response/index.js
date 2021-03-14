const http = require('http');
const https = require('https');
const fs = require('fs');
const FileType = require('file-type');

const sharp = require('sharp');


function parseTransformOptions(transformString){
    if(transformString === false){
        return false;
    }
    let result = transformString.match(/tr:(.*)/);
    let transformOptions = {};
    if(typeof result != "undefined" && result != null && !!result[1]){
        let options = result[1].split(',');
        for(let i in options){
            let item = options[i].split('-');
            transformOptions[item[0]] = item[1];
        }
        return transformOptions;
    }
    return false;
}

const variables = {
    webpExtension: 'webp'
};

// headers that cloudfront does not allow in the http response
const blacklistedHeaders = [
    /^connection$/i,
    /^content-length$/i,
    /^expect$/i,
    /^keep-alive$/i,
    /^proxy-authenticate$/i,
    /^proxy-authorization$/i,
    /^proxy-connection$/i,
    /^trailer$/i,
    /^upgrade$/i,
    /^x-accel-buffering$/i,
    /^x-accel-charset$/i,
    /^x-accel-limit-rate$/i,
    /^x-accel-redirect$/i,
    /^X-Amz-Cf-.*/i,
    /^X-Amzn-.*/i,
    /^X-Cache.*/i,
    /^X-Edge-.*/i,
    /^X-Forwarded-Proto.*/i,
    /^X-Real-IP$/i
];

let RequestOptions = function(request) {
    let _self = this;

    this.originUri = false;
    this.transformOptions = false;
    this.requestHeaders = false;
    this.requestOrigin = false

    this.transformDefaults = {
        w: null,
        h: null
    }

    this.getOriginUri = function(){
        return _self.originUri
    }

    this.getOriginFullUrl = function(){
        return `${_self.requestOrigin.protocol}://${_self.requestOrigin.domainName}${_self.requestOrigin.path}${_self.originUri}`;
    }

    this.getTransformOptions = function(){
        return _self.transformOptions;
    }

    this.getRequestHeaders = function(){
        return _self.requestHeaders;
    }

    this.doesViewerSupportWebp = function(){
        let accept = _self.requestHeaders['accept'] ? _self.requestHeaders['accept'][0].value : "";

        return accept.includes(variables.webpExtension);
    }

    this.parseTransformOptions = function(transformString){
        if(transformString === false){
            return false;
        }
        let result = transformString.match(/tr:(.*)/);
        let transformOptions = {};
        if(typeof result != "undefined" && result != null && !!result[1]){
            let options = result[1].split(',');
            for(let i in options){
                let item = options[i].split('-');
                if(['w', 'h'].includes(item[0])){
                    item[1] = parseInt(item[1]);
                }
                transformOptions[item[0]] = item[1];
            }
            return {..._self.transformDefaults, ...transformOptions};
        }
        return false;
    }

    this._init = function(request){
        let result = request.uri.match(/\/(tr:.+?\/)(.*)/);
        if(typeof result != "undefined" && result != null){
            _self.transformOptions = _self.parseTransformOptions(result[1].replace(/\/$/, ""));
            _self.originUri = '/' + result[2];
        }else{
            _self.originUri = request.uri;
        }
        _self.requestHeaders = request.headers;
        _self.requestOrigin = request.origin.custom;
    }

    _self._init(request);
}


/**
 * Downloads file from remote HTTP[S] host and puts its contents to the
 * specified location.
 */
async function download(url, filePath) {
    const proto = !url.charAt(4).localeCompare('s') ? https : http;

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        let fileInfo = null;

        const request = proto.get(url, response => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
                return;
            }

            fileInfo = {
                headers: response.headers,
                mime: response.headers['content-type'],
                size: parseInt(response.headers['content-length'], 10),
            };

            response.pipe(file);
        });

        // The destination stream is ended by the time it's called
        file.on('finish', () => resolve(fileInfo));

        request.on('error', err => {
            fs.unlink(filePath, () => reject(err));
        });

        file.on('error', err => {
            fs.unlink(filePath, () => reject(err));
        });

        request.end();
    });
}

async function transformObject(requestOptions, originStreamPath){
    let originBuffer = fs.readFileSync(originStreamPath);
    let transformOptions = requestOptions.getTransformOptions();
    const contentType = await FileType.fromBuffer(originBuffer);
    let mime = contentType.mime.split('/');

    if(mime[0] === 'image'){
        let format = requestOptions.doesViewerSupportWebp() ? variables.webpExtension : mime[1];
        mime = mime[0] + '/' + format;

        originBuffer = await sharp(originBuffer)
            .resize(transformOptions.w, transformOptions.h)
            .toFormat(format, {quality: 80})
            .toBuffer();
    }else{
        throw new Error("Response is not image!");
    }

    return {buffer: originBuffer, mime: mime};
}

exports.handler = async (event, context, callback) => {
    let response = event.Records[0].cf.response;
    const request = event.Records[0].cf.request;

    const originStreamPath = '/tmp/originStream';

    const requestOptions = new RequestOptions(request);
    const originFullUrl = requestOptions.getOriginFullUrl();

    try{
        console.log('Start download file from origin');
        let fileInfo = await download(originFullUrl, originStreamPath);
        if(fileInfo.mime.indexOf('image') < 0){
            throw new Error("Response is not image!");
        }
        // grab headers from the origin request and reformat them
        // to match the lambda@edge return format
        const originHeaders = Object.keys(fileInfo.headers)
            // some headers we get back from the origin
            // must be filtered out because they are blacklisted by cloudfront
            .filter((header) => blacklistedHeaders.every((blheader) => !blheader.test(header)))
            .reduce((acc, header) => {
                acc[header.toLowerCase()] = [
                    {
                        key: header,
                        value: fileInfo.headers[header]
                    }
                ];
                return acc;
            }, {})
        console.log('File downloaded', fileInfo);
        console.log('Start transform response');
        let transformBuffer = await transformObject(requestOptions, originStreamPath);
        console.log('Response has been transformed', transformBuffer.mime);
        response.headers['content-type'] = [{ key: 'Content-Type', value: transformBuffer.mime}];
        response.headers['cache-control'] = originHeaders['cache-control'];
        response.headers['expires'] = originHeaders['expires'];
        response.headers['last-modified'] = originHeaders['last-modified'];
        delete response.headers['content-encoding'];
        response.bodyEncoding = 'base64';
        response.body = transformBuffer.buffer.toString('base64');
        response.status = '200';
        response.statusDescription = 'OK';

        callback(null, response);
    } catch (err){
        console.log('Error while getting origin body response', err);
        callback(null, response);
    }
}