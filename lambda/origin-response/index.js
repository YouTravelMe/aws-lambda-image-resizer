const http = require('http');
const https = require('https');
const fs = require('fs');
const FileType = require('file-type');


const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const sharp = require('sharp');

const bucketName = 'ytme.static';
const HostCustomOrigin = 'https://youtravel.me';
let saveToS3 = async (bucket, key, buf) => {
    await s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: buf.buffer,
        ContentEncoding: 'base64',
        ContentType: buf.mime,
    }).promise();
};

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

let RequestOptions = function(request) {
    let _self = this;

    this.originUri = false;
    this.request = false;
    this.transformOptions = false;

    this.transformDefaults = {
        w: null,
        h: null
    }

    this.getRequestUri = function(){
        return _self.request.uri;
    }
    this.getOriginUri = function(){
        return _self.originUri
    }

    this.isS3Origin = function(){
        return !!_self.request.origin.hasOwnProperty('s3');
    }

    this.getOriginFullUrl = function(){
        return `${HostCustomOrigin}${_self.originUri}`;
    }

    this.getTransformOptions = function(){
        return _self.transformOptions;
    }

    this.doesViewerSupportWebp = function(){
        let accept = _self.request.headers['accept'] ? _self.request.headers['accept'][0].value : "";
        return !!accept.includes(variables.webpExtension);
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
        _self.request = request;
        let result = _self.request.uri.match(/\/(tr:.+?\/)(.*)/);
        if(typeof result != "undefined" && result != null){
            _self.transformOptions = _self.parseTransformOptions(result[1].replace(/\/$/, ""));
            _self.originUri = '/' + result[2];
        }else{
            _self.originUri = _self.request.uri;
        }
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

        originBuffer = await sharp(originBuffer,{ failOnError: false })
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
    const requestOptions = new RequestOptions(request);
    const originStreamPath = '/tmp/originStream';
    let allow = (requestOptions.isS3Origin() && [403, 404].includes(parseInt(response.status)))
                    || !requestOptions.isS3Origin()
    if(allow){
        const originFullUrl = requestOptions.getOriginFullUrl();
        try{
            console.log('Start download file from origin: ',  originFullUrl);
            let fileInfo = await download(originFullUrl, originStreamPath);
            if(fileInfo.mime.indexOf('image') < 0){
                throw new Error("Response is not image!");
            }
            // grab headers from the origin request and reformat them
            // to match the lambda@edge return format
            const originHeaders = Object.keys(fileInfo.headers)
                .reduce((acc, header) => {
                    acc[header.toLowerCase()] = [
                        {
                            key: header,
                            value: fileInfo.headers[header]
                        }
                    ];
                    return acc;
                }, {})
            console.log('File downloaded ', fileInfo);

            console.log('Start transform response');
            let transformBuffer = await transformObject(requestOptions, originStreamPath);
            console.log('Response has been transformed ', transformBuffer.mime);

            saveToS3(bucketName, requestOptions.getRequestUri().substring(1), transformBuffer);
            console.log('Save s3 object as ', requestOptions.getRequestUri().substring(1));

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
            response.status = '500';
            response.statusDescription = 'Lambda Error';
            response.body = 'Error while getting origin body response';
            console.log('Error while getting origin body response ', err);
            callback(null, response);
        }
    }else{
        callback(null, response);
    }
}