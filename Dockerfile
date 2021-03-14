FROM amazonlinux:2

WORKDIR /tmp
#install the dependencies
RUN yum -y install gcc-c++ && yum -y install findutils && yum -y install tar && yum -y install gzip

RUN touch ~/.bashrc && chmod +x ~/.bashrc

RUN curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.37.2/install.sh | bash

RUN source ~/.bashrc && nvm install 10

WORKDIR /build