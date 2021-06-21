
docker build --tag amazonlinux:nodejs .
docker run --rm --volume ${PWD}/lambda/origin-response:/build amazonlinux:nodejs /bin/bash -c "source ~/.bashrc; npm init -f -y; npm install sharp --save; npm install file-type --save; npm install --only=prod"
mkdir -p dist && cd lambda/origin-response && zip -FS -q -r ../../dist/origin-response-function.zip * && cd ../..

mkdir -p dist && cd lambda/viewer-request && zip -FS -q -r ../../dist/viewer-request-function.zip * && cd ../..
