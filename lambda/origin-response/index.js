const http = require('http');
const https = require('https');
const fs = require('fs');
const FileType = require('file-type');

const ImageRequest = require('./image-request.js');

const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const sharp = require('sharp');

const bucketName = '%BUCKET_NAME%';
/**
 * функция которая сохраняет файл в s3
 * @param bucket
 * @param key
 * @param buf
 * @returns {Promise<*>}
 */
let saveToS3 = async (bucket, key, buf) => {
    await s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: buf.buffer,
        CacheControl: "public, s-maxage=15552000, max-age=15552000, must-revalidate",
        ContentEncoding: 'base64',
        ContentType: buf.mime,
    }).promise();
    return key;
};

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

/**
 * функция которая изменяет объект в зависимости от переданных в URI настроек
 * @param requestOptions
 * @param originStreamPath
 * @returns {Promise<{mime: string[], buffer: Buffer}>}
 */
async function transformObject(requestOptions, originStreamPath){
    let originBuffer = fs.readFileSync(originStreamPath);
    let transformOptions = requestOptions.getTransformOptions();
    const contentType = await FileType.fromBuffer(originBuffer);
    let mime = contentType.mime.split('/');
    console.log(transformOptions, mime);
    if(mime[0] === 'image'){

        let format = mime[1];
        if(requestOptions.isAllowWebp()){
            format = "webp";
        }else if(format === 'webp'){
            format = "jpeg";
        }

        mime = mime[0] + '/' + format;

        originBuffer = await sharp(originBuffer,{ failOnError: false })
            .resize(transformOptions.w, transformOptions.h, {
                withoutEnlargement: true
            })
            .toFormat(format, {quality: 80})
            .toBuffer();

        // If the converted image is larger than Lambda's payload hard limit, throw an error.
        const lambdaPayloadLimit = 6 * 1024 * 1024;
        if (originBuffer.toString('base64').length > lambdaPayloadLimit) {
            throw new Error("The converted image is too large to return.");
        }
    }else{
        throw new Error("Response is not image!");
    }

    return {buffer: originBuffer, mime: mime};
}

exports.handler = async (event, context, callback) => {
    let response = event.Records[0].cf.response;
    const request = event.Records[0].cf.request;
    const requestOptions = new ImageRequest(request);
    const originStreamPath = '/tmp/originStream';
    const originFullUrl = requestOptions.getOriginFullUrl(true);
    let downloadFromOrigin = false;

    if([403, 404].includes(parseInt(response.status))
        || originFullUrl.indexOf('local/') >= 0){
        downloadFromOrigin = true;
    }
    console.log("Download from origin: ", downloadFromOrigin);
    if(!!downloadFromOrigin){

        try{
            console.log('Start download file from origin: ',  originFullUrl);
            let fileInfo = await download(originFullUrl, originStreamPath);
            let originBuffer = fs.readFileSync(originStreamPath);
            const contentType = await FileType.fromBuffer(originBuffer);
            let mime = contentType.mime.split('/');
            if(mime[0] !== 'image'){
                throw new Error("Response is not image!");
            }

            console.log('Start transform response');
            let transformBuffer = await transformObject(requestOptions, originStreamPath);
            console.log('Response has been transformed ', transformBuffer.mime);

            const headers = getResponseHeaders(fileInfo.headers, transformBuffer.mime);
            headers['transfer-encoding'] = response.headers['transfer-encoding'];
            headers['via'] = response.headers['via'];
            saveToS3(bucketName, requestOptions.getRequestUri().substring(1), transformBuffer);

            console.log('Saved s3 object as ', requestOptions.getRequestUri().substring(1));

            callback(null, {
                bodyEncoding: 'base64',
                body: transformBuffer.buffer.toString('base64'),
                status: '200',
                statusDescription: 'OK',
                headers: headers
            });
        } catch (err){
            response.status = '500';
            response.statusDescription = 'Lambda Error';
            response.body = 'Error while getting origin body response';
            console.error('Error while getting origin body response ', err);
            callback(null, response);
        }
    }else{
        callback(null, response);
    }
}

/**
 * Generates the appropriate set of response headers based on a success
 * or error condition.
 * @param {boolean} originHeaders - headers form origin response
 * @param {boolean} mime - mime type of transformed file
 * @return {object} - Headers object
 */
const getResponseHeaders = (originHeaders, mime = false) => {

    const headers = {}

    // grab headers from the origin request and reformat them
    // to match the lambda@edge return format
    let responseHeaders = Object.keys(originHeaders)
        .reduce((acc, header) => {
            acc[header.toLowerCase()] = [
                {
                    key: header,
                    value: originHeaders[header]
                }
            ];
            return acc;
        }, {})
    if(mime === false){
        headers["Content-Type"] = responseHeaders["content-type"];
    }else{
        headers["Content-Type"] = [{ key: 'Content-Type', value: mime}];
    }

    headers["Expires"] = responseHeaders["expires"];
    headers["Last-Modified"] = responseHeaders["last-modified"];
    headers["Cache-Control"] = [{key: "Cache-Control", value: "public, s-maxage=15552000, max-age=15552000, must-revalidate"}];

    return headers;
}