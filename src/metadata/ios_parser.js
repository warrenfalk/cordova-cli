/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/
var fs            = require('fs'),
    path          = require('path'),
    xcode         = require('xcode'),
    util          = require('../util'),
    events        = require('../events'),
    shell         = require('shelljs'),
    child_process = require('child_process'),
    plist         = require('plist'),
    semver        = require('semver'),
    Q             = require('q'),
    config_parser = require('../config_parser'),
    config        = require('../config'),
    imagemagick   = require('imagemagick');

var MIN_XCODE_VERSION = '>=4.5.x';

var default_prefs = {
    "KeyboardDisplayRequiresUserAction":"true",
    "SuppressesIncrementalRendering":"false",
    "UIWebViewBounce":"true",
    "TopActivityIndicator":"gray",
    "EnableLocation":"false",
    "EnableViewportScale":"false",
    "AutoHideSplashScreen":"true",
    "ShowSplashScreenSpinner":"true",
    "MediaPlaybackRequiresUserAction":"false",
    "AllowInlineMediaPlayback":"false",
    "OpenAllWhitelistURLsInWebView":"false",
    "BackupWebStorage":"cloud"
};

module.exports = function ios_parser(project) {
    try {
        var xcodeproj_dir = fs.readdirSync(project).filter(function(e) { return e.match(/\.xcodeproj$/i); })[0];
        if (!xcodeproj_dir) throw new Error('The provided path "' + project + '" is not a Cordova iOS project.');
        this.xcodeproj = path.join(project, xcodeproj_dir);
        this.originalName = this.xcodeproj.substring(this.xcodeproj.lastIndexOf(path.sep)+1, this.xcodeproj.indexOf('.xcodeproj'));
        this.cordovaproj = path.join(project, this.originalName);
    } catch(e) {
        throw new Error('The provided path is not a Cordova iOS project.');
    }
    this.path = project;
    this.pbxproj = path.join(this.xcodeproj, 'project.pbxproj');
    this.config_path = path.join(this.cordovaproj, 'config.xml');
    this.config = new util.config_parser(this.config_path);
};

// Returns a promise.
module.exports.check_requirements = function(project_root) {
    events.emit('log', 'Checking iOS requirements...');
    // Check xcode + version.
    var command = 'xcodebuild -version';
    events.emit('verbose', 'Running "' + command + '" (output to follow)');
    var d = Q.defer();
    child_process.exec(command, function(err, output, stderr) {
        events.emit('verbose', output+stderr);
        if (err) {
            d.reject(new Error('Xcode is (probably) not installed, specifically the command `xcodebuild` is unavailable or erroring out. Output of `'+command+'` is: ' + output + stderr));
        } else {
            var xc_version = output.split('\n')[0].split(' ')[1];
            if(xc_version.split('.').length === 2){
                xc_version += '.0';
            }
            if (!semver.satisfies(xc_version, MIN_XCODE_VERSION)) {
                d.reject(new Error('Xcode version installed is too old. Minimum: ' + MIN_XCODE_VERSION + ', yours: ' + xc_version));
            } else d.resolve();
        }
    });
    return d.promise;
};

module.exports.prototype = {
    // Returns a promise.
    update_from_config:function(config) {
        if (config instanceof config_parser) {
        } else {
            return Q.reject(new Error('update_from_config requires a config_parser object'));
        }
        var name = config.name();
        var pkg = config.packageName();
        var version = config.version();

        // Update package id (bundle id)
        var plistFile = path.join(this.cordovaproj, this.originalName + '-Info.plist');
        var infoPlist = plist.parseFileSync(plistFile);
        infoPlist['CFBundleIdentifier'] = pkg;

        // Update version (bundle version)
        infoPlist['CFBundleVersion'] = version;
        var info_contents = plist.build(infoPlist);
        info_contents = info_contents.replace(/<string>[\s\r\n]*<\/string>/g,'<string></string>');
        fs.writeFileSync(plistFile, info_contents, 'utf-8');
        events.emit('verbose', 'Wrote out iOS Bundle Identifier to "' + pkg + '"');
        events.emit('verbose', 'Wrote out iOS Bundle Version to "' + version + '"');

        if (name != this.originalName) {
            // Update product name inside pbxproj file
            var proj = new xcode.project(this.pbxproj);
            var parser = this;
            var d = Q.defer();
            proj.parse(function(err,hash) {
                if (err) {
                    d.reject(new Error('An error occured during parsing of project.pbxproj. Start weeping. Output: ' + err));
                } else {
                    proj.updateProductName(name);
                    fs.writeFileSync(parser.pbxproj, proj.writeSync(), 'utf-8');
                    // Move the xcodeproj and other name-based dirs over.
                    shell.mv(path.join(parser.cordovaproj, parser.originalName + '-Info.plist'), path.join(parser.cordovaproj, name + '-Info.plist'));
                    shell.mv(path.join(parser.cordovaproj, parser.originalName + '-Prefix.pch'), path.join(parser.cordovaproj, name + '-Prefix.pch'));
                    shell.mv(parser.xcodeproj, path.join(parser.path, name + '.xcodeproj'));
                    shell.mv(parser.cordovaproj, path.join(parser.path, name));
                    // Update self object with new paths
                    var old_name = parser.originalName;
                    parser = new module.exports(parser.path);
                    // Hack this shi*t
                    var pbx_contents = fs.readFileSync(parser.pbxproj, 'utf-8');
                    pbx_contents = pbx_contents.split(old_name).join(name);
                    fs.writeFileSync(parser.pbxproj, pbx_contents, 'utf-8');
                    events.emit('verbose', 'Wrote out iOS Product Name and updated XCode project file names from "'+old_name+'" to "' + name + '".');
                    d.resolve();
                }
            });
            return d.promise;
        } else {
            events.emit('verbose', 'iOS Product Name has not changed (still "' + this.originalName + '")');
            return Q();
        }
    },

    // Returns the platform-specific www directory.
    www_dir:function() {
        return path.join(this.path, 'www');
    },

    staging_dir: function() {
        return path.join(this.path, '.staging', 'www');
    },

    config_xml:function(){
        return this.config_path;
    },

    update_www:function() {
        var projectRoot = util.isCordova(this.path);
        var www = util.projectWww(projectRoot);
        var project_www = this.www_dir();

        // remove the stock www folder
        shell.rm('-rf', project_www);

        // copy over project www assets
        shell.cp('-rf', www, this.path);

        // write out proper cordova.js
        var custom_path = config.has_custom_path(projectRoot, 'ios');
        var lib_path = path.join(util.libDirectory, 'ios', 'cordova', require('../../platforms').ios.version);
        if (custom_path) lib_path = custom_path;
        shell.cp('-f', path.join(lib_path, 'CordovaLib', 'cordova.js'), path.join(project_www, 'cordova.js'));

    },

    // update the overrides folder into the www folder
    update_overrides:function() {
        var projectRoot = util.isCordova(this.path);
        var merges_path = path.join(util.appDir(projectRoot), 'merges', 'ios');
        if (fs.existsSync(merges_path)) {
            var overrides = path.join(merges_path, '*');
            shell.cp('-rf', overrides, this.www_dir());
        }
    },

    // update the overrides folder into the www folder
    update_staging:function() {
        var projectRoot = util.isCordova(this.path);
        if (fs.existsSync(this.staging_dir())) {
            var staging = path.join(this.staging_dir(), '*');
            shell.cp('-rf', staging, this.www_dir());
        }
    },

    copy_resources:function(cfg) {
        this.copy_splashes(cfg);
        this.copy_icons(cfg);
    },

    hasImageMagick: function(callback) {
        var exec = require('child_process').exec,
            child;

        child = exec('which convert', function(error, stdout, stderr) {
            callback(error);
        });
    },

    generate_assets:function(assets, sizeMapping, skip, cfg) {
        var self = this;
        this.hasImageMagick(function(error) {
            if (error) {
                return events.emit('log', 'ImageMagick convert utility missing');
            }
            self.generate_assets_raw('portrait', assets, sizeMapping, skip, cfg);
            self.generate_assets_raw('landscape', assets, sizeMapping, skip, cfg);
        });
    },

    generate_assets_raw: function(orientation, assets, sizeMapping, skip, cfg) {
        var www = path.dirname(cfg.path),
            sourceImage,
            dest,
            width,
            height;


        sourceImage = this.get_source_asset(assets, orientation);

        if (!sourceImage)
            return events.emit('log', ('Could not find iOS source image for ' + orientation).red);

        sourceImage = path.join(www, sourceImage.attrib.src);

        if (!fs.existsSync(sourceImage))
            return events.emit('log', sourceImage + ' does not exist!');

        for (key in sizeMapping) {
            dest = path.join(this.cordovaproj, sizeMapping[key].dest);
            if (skip.indexOf(dest) !== -1) {
                continue;
            }

            width = sizeMapping[key].width;
            height = sizeMapping[key].height;

            if (sizeMapping[key].orientation != orientation) {
                continue;
            }

            events.emit('log', 'Generating iOS asset '.yellow + dest + ' from ' + sourceImage + ' [' + width + 'x' + height + ']');

            imagemagick.resize({
                srcPath: sourceImage,
                dstPath: dest,
                width: width,
                height: height,
                format: 'png'
            }, function(err, stdout, stderr) {
                if (err) {
                    events.emit('log', 'Error generating image, is imagemagick installed?');
                    events.emit('log', stderr);
                }
            });

        }
    },

    get_source_asset:function(assets, orientation) {
        var idx, asset;
        for (idx in assets) {
            asset = assets[idx];
            if (asset.attrib['gap:platform'] == 'source' && asset.attrib['gap:orientation'] == orientation) {
                return asset;
            }
        }
        return false;
    },

    copy_splashes:function(cfg) {
        var projectRoot = util.isCordova(this.path),
            splashes = cfg.doc.getroot().findall('.//splash'),
            www = util.projectWww(this.path),
            splash,
            dest,
            copied = [],
            sizeMapping = {
                '480': {dest: 'Resources/splash/Default~iphone.png', width: '320', height: '480', orientation: 'portrait'},
                '960': {dest: 'Resources/splash/Default@2x~iphone.png', width: '640', height: '960', orientation: 'portrait'},
                '1136': {dest: 'Resources/splash/Default-568h@2x~iphone.png', width: '640', height: '1156', orientation: 'portrait'},
                '1004': {dest: 'Resources/splash/Default-Portrait~ipad.png', width: '768', height: '1004', orientation: 'portrait'},
                '2008': {dest: 'Resources/splash/Default-Portrait@2x~ipad.png', width: '1536', height: '2008', orientation: 'portrait'},
                '748': {dest: 'Resources/splash/Default-Landscape~ipad.png', width: '1024', height: '748', orientation: 'landscape'},
                '1496': {dest: 'Resources/splash/Default-Landscape@2x~ipad.png', width: '2048', height: '1496', orientation: 'landscape'},
            };

        for (idx in splashes) {
            splash = splashes[idx];

            if (splash.attrib['gap:platform'] != 'ios')
               continue;

            if (!sizeMapping[splash.attrib.height])
               continue;

            dest = path.join(this.cordovaproj, sizeMapping[splash.attrib.height].dest);
            events.emit('log', 'Copying iOS splash '.green + path.join(www, splash.attrib.src) + ' to ' + dest);
            shell.cp('-f', path.join(www, splash.attrib.src), dest);
            copied.push(dest);
        }

        this.generate_assets(splashes, sizeMapping, copied, cfg);
    },

    copy_icons:function(cfg) {
        var projectRoot = util.isCordova(this.path),
            icons = cfg.doc.getroot().findall('.//icon'),
            www = util.projectWww(this.path),
            icon,
            dest,
            copied = [],
            sizeMapping = {
                '57': {dest: 'Resources/icons/icon.png', width: '57', height: '57', orientation: 'portrait'},
                '72': {dest: 'Resources/icons/icon-72.png', width: '72', height: '72', orientation: 'portrait'},
                '114': {dest: 'Resources/icons/icon@2x.png', width: '114', height: '114', orientation: 'portrait'},
                '144': {dest: 'Resources/icons/icon-72@2x.png', width: '144', height: '144', orientation: 'portrait'},
            };

        for (idx in icons) {
            icon = icons[idx];

            if (icon.attrib['gap:platform'] != 'ios')
               continue;

            if (!sizeMapping[icon.attrib.width])
               continue;

            dest = path.join(this.cordovaproj, sizeMapping[icon.attrib.width].dest);
            events.emit('log', 'Copying iOS icon '.green + path.join(www, icon.attrib.src) + ' to ' + dest);
            shell.cp('-f', path.join(www, icon.attrib.src), dest);
            copied.push(dest);
        }

        this.generate_assets(icons, sizeMapping, copied, cfg);
    },

    // Returns a promise.
    update_project:function(cfg) {
        var self = this;
        return this.update_from_config(cfg)
        .then(function() {
            self.update_overrides();
            self.update_staging();
            self.copy_resources(cfg);
            util.deleteSvnFolders(self.www_dir());
        });
    }
};
