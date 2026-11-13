// 图像色管内核：对 LittleCMS2 的原生封装。
// 只承担“色彩配置与像素变换”职责；文件编解码与 ICC 嵌入由 JS 层（sharp）负责。
#include <napi.h>
#include <lcms2.h>
#include <vector>
#include <string>
#include <cstring>
#include <cmath>

static void throwLcms(Napi::Env env, const char* stage) {
    throw Napi::Error::New(env, std::string("lcms2 失败 @ ") + stage);
}

static cmsHPROFILE openMemProfile(Napi::Env env, Napi::Uint8Array& buf, const char* stage) {
    if (buf.ByteLength() < 4) throw Napi::Error::New(env, "ICC 数据过短，不是有效配置");
    cmsHPROFILE h = cmsOpenProfileFromMem(buf.Data(), buf.ByteLength());
    if (!h) throwLcms(env, stage);
    return h;
}

static std::string strTag(cmsHPROFILE h, cmsTagSignature sig, const char* fallback = "") {
    cmsMLU* mlu = (cmsMLU*)cmsReadTag(h, sig);
    if (!mlu) return std::string(fallback);
    char buf[1024];
    cmsUInt32Number n = cmsMLUgetASCII(mlu, "en", "US", buf, sizeof(buf));
    if (n == 0) return std::string(fallback);
    return std::string(buf);
}

static Napi::Value profileInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    cmsHPROFILE h = openMemProfile(env, buf, "cmsOpenProfileFromMem");
    Napi::Object o = Napi::Object::New(env);
    char tmp[256];
    cmsGetProfileInfoASCII(h, cmsInfoDescription, "en", "US", tmp, sizeof(tmp));
    o.Set("description", Napi::String::New(env, tmp));
    cmsGetProfileInfoASCII(h, cmsInfoManufacturer, "en", "US", tmp, sizeof(tmp));
    o.Set("manufacturer", Napi::String::New(env, tmp));
    cmsGetProfileInfoASCII(h, cmsInfoModel, "en", "US", tmp, sizeof(tmp));
    o.Set("model", Napi::String::New(env, tmp));
    cmsGetProfileInfoASCII(h, cmsInfoCopyright, "en", "US", tmp, sizeof(tmp));
    o.Set("copyright", Napi::String::New(env, tmp));

    auto sigToText = [](cmsUInt32Number sig, char out[5]) {
        out[0] = (char)((sig >> 24) & 0xFF);
        out[1] = (char)((sig >> 16) & 0xFF);
        out[2] = (char)((sig >> 8) & 0xFF);
        out[3] = (char)(sig & 0xFF);
        out[4] = 0;
    };
    char sig[5] = {0};
    sigToText(cmsGetDeviceClass(h), sig);
    o.Set("deviceClassSig", Napi::String::New(env, sig));
    sigToText(cmsGetColorSpace(h), sig);
    o.Set("colorSpaceSig", Napi::String::New(env, sig));
    sigToText(cmsGetPCS(h), sig);
    o.Set("pcsSig", Napi::String::New(env, sig));
    o.Set("version", Napi::Number::New(env, cmsGetProfileVersion(h)));
    o.Set("isMatrixShaper", Napi::Boolean::New(env, cmsIsMatrixShaper(h) != 0));
    o.Set("hasAToB0", Napi::Boolean::New(env, cmsIsTag(h, cmsSigAToB0Tag) != 0));
    o.Set("size", Napi::Number::New(env, (double)buf.ByteLength()));

    // 配置身份：文件长度 + 头中渲染意图 + 描述标签；JS 层另算整文件 SHA-256 指纹
    cmsUInt32Number ri = cmsGetHeaderRenderingIntent(h);
    o.Set("headerRenderingIntent", Napi::Number::New(env, (double)ri));
    o.Set("tagProfileDescription", Napi::String::New(env, strTag(h, cmsSigProfileDescriptionTag)));

    cmsCloseProfile(h);
    return o;
}

static cmsUInt32Number intentFromJs(Napi::Env env, const Napi::Value& v) {
    if (!v.IsString()) throw Napi::Error::New(env, "renderingIntent 必须为字符串");
    std::string s = v.As<Napi::String>().Utf8Value();
    if (s == "perceptual") return INTENT_PERCEPTUAL;
    if (s == "relative-colorimetric") return INTENT_RELATIVE_COLORIMETRIC;
    if (s == "saturation") return INTENT_SATURATION;
    if (s == "absolute-colorimetric") return INTENT_ABSOLUTE_COLORIMETRIC;
    throw Napi::Error::New(env, "未知渲染意图: " + s);
}

// 通用像素变换。参数见 JS 内核层 convert() 的文档。
static Napi::Value convertPixels(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object args = info[0].As<Napi::Object>();
    Napi::Uint8Array srcIcc = args.Get("srcIcc").As<Napi::Uint8Array>();
    Napi::Uint8Array dstIcc = args.Get("dstIcc").As<Napi::Uint8Array>();
    Napi::Uint8Array inPx = args.Get("input").As<Napi::Uint8Array>();
    Napi::Uint8Array outPx = args.Get("output").As<Napi::Uint8Array>();
    cmsUInt32Number width = args.Get("width").As<Napi::Number>().Uint32Value();
    cmsUInt32Number height = args.Get("height").As<Napi::Number>().Uint32Value();
    cmsUInt32Number channels = args.Get("channels").As<Napi::Number>().Uint32Value();
    cmsUInt32Number bps = args.Get("bitsPerSample").As<Napi::Number>().Uint32Value();
    cmsUInt32Number intent = intentFromJs(env, args.Get("renderingIntent"));
    bool bpc = args.Get("blackPointCompensation").As<Napi::Boolean>().Value();
    std::string mode = args.Get("mode").As<Napi::String>().Utf8Value();
    bool hasAlpha = args.Get("hasAlpha").As<Napi::Boolean>().Value();

    if (channels != 3) throw Napi::Error::New(env, "当前仅支持 RGB 三通道颜色数据");
    if (bps != 8 && bps != 16) throw Napi::Error::New(env, "bitsPerSample 仅支持 8 或 16");

    cmsHPROFILE hIn = openMemProfile(env, srcIcc, "打开源配置");
    cmsHPROFILE hOut = openMemProfile(env, dstIcc, "打开目标配置");

    cmsUInt32Number inType, outType;
    // 本平台 lcms2 编译为小端：标准 TYPE_RGB_16 按本机序解释，而 PNG/ICC 是大端，
    // 故 16 位必须用 _SE（交换到指定的大端线格式）。8 位无字节序问题。
    if (bps == 8) { inType = TYPE_RGB_8; outType = TYPE_RGB_8; }
    else { inType = TYPE_RGB_16_SE; outType = TYPE_RGB_16_SE; }

    // 不使用 cmsFLAGS_COPY_ALPHA：alpha 已在下方手工隔离，且该标志会干扰 16 位打包
    cmsUInt32Number dwFlags = 0;
    cmsHTRANSFORM xform = nullptr;

    if (mode == "convert") {
        if (bpc) dwFlags |= cmsFLAGS_BLACKPOINTCOMPENSATION;
        xform = cmsCreateTransform(hIn, inType, hOut, outType, intent, dwFlags);
    } else if (mode == "gamut-check" || mode == "softproof") {
        // 软打样：源->目标（软打样配置），并对越界像素输出警报色
        cmsUInt32Number proofIntent = intent;
        cmsUInt32Number gi = cmsFLAGS_GAMUTCHECK;
        // 警报码统一使用 16 位量程（lcms 内部按输出位深自动缩放）
        cmsUInt16Number alarm[3] = { 65535, 0, 65535 };
        cmsSetAlarmCodes(alarm);
        if (bpc) dwFlags |= cmsFLAGS_BLACKPOINTCOMPENSATION;
        if (mode == "gamut-check") dwFlags |= gi;
        xform = cmsCreateProofingTransform(hIn, inType, hOut, outType, hOut,
            proofIntent, intent, dwFlags);
    } else {
        cmsCloseProfile(hIn); cmsCloseProfile(hOut);
        throw Napi::Error::New(env, "未知模式: " + mode);
    }
    if (!xform) { cmsCloseProfile(hIn); cmsCloseProfile(hOut); throwLcms(env, "cmsCreateTransform"); }

    cmsUInt32Number pixels = width * height;
    cmsUInt32Number bpe = bps / 8;
    cmsUInt32Number inStride = hasAlpha ? (4 * bpe) : (3 * bpe);
    if (inPx.ByteLength() < (size_t)pixels * inStride ||
        outPx.ByteLength() < (size_t)pixels * inStride) {
        cmsDeleteTransform(xform); cmsCloseProfile(hIn); cmsCloseProfile(hOut);
        throw Napi::Error::New(env, "像素缓冲尺寸与 width/height/channels 不符");
    }

    // 统一抽出连续 RGB（去掉 alpha），保证透明通道永不进入色彩引擎
    size_t rgbBytes = (size_t)pixels * 3 * bpe;
    std::vector<unsigned char> rgbIn(rgbBytes), rgbOut(rgbBytes);
    for (cmsUInt32Number px = 0; px < pixels; px++) {
        memcpy(&rgbIn[(size_t)px * 3 * bpe],
               inPx.Data() + (size_t)px * inStride, 3 * bpe);
    }
    cmsDoTransform(xform, rgbIn.data(), rgbOut.data(), pixels);
    for (cmsUInt32Number px = 0; px < pixels; px++) {
        memcpy(outPx.Data() + (size_t)px * inStride,
               &rgbOut[(size_t)px * 3 * bpe], 3 * bpe);
        if (hasAlpha) {
            // alpha 逐字节原样装回，绝不作为颜色采样参与变换
            memcpy(outPx.Data() + (size_t)px * inStride + 3 * bpe,
                   inPx.Data() + (size_t)px * inStride + 3 * bpe, bpe);
        }
    }

    cmsDeleteTransform(xform);
    cmsCloseProfile(hIn);
    cmsCloseProfile(hOut);
    return env.Undefined();
}

// RGB（内部 0..1 浮点，线性/编码由 profile 决定）-> Lab（D50 编码：L 0..100, a/b -128..127）
static Napi::Value rgbToLab(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object args = info[0].As<Napi::Object>();
    Napi::Uint8Array icc = args.Get("icc").As<Napi::Uint8Array>();
    Napi::Float32Array rgb = args.Get("rgb").As<Napi::Float32Array>();
    cmsHPROFILE h = openMemProfile(env, icc, "rgbToLab 打开配置");
    cmsHPROFILE lab = cmsCreateLab4Profile(nullptr);
    cmsHTRANSFORM x = cmsCreateTransform(h, TYPE_RGB_DBL, lab, TYPE_Lab_DBL,
        INTENT_RELATIVE_COLORIMETRIC, 0);
    if (!x) { cmsCloseProfile(h); cmsCloseProfile(lab); throwLcms(env, "rgbToLab 变换"); }
    cmsUInt32Number n = rgb.ElementLength() / 3;
    Napi::Float64Array out = Napi::Float64Array::New(env, n * 3);
    std::vector<cmsUInt16Number> tmp16;
    for (cmsUInt32Number i = 0; i < n; i++) {
        cmsFloat64Number in[3] = { (cmsFloat64Number)rgb[i*3], (cmsFloat64Number)rgb[i*3+1], (cmsFloat64Number)rgb[i*3+2] };
        cmsCIELab Lab;
        cmsDoTransform(x, in, &Lab, 1);
        out[i*3] = Lab.L; out[i*3+1] = Lab.a; out[i*3+2] = Lab.b;
    }
    cmsDeleteTransform(x); cmsCloseProfile(h); cmsCloseProfile(lab);
    return out;
}

// Lab -> 指定配置下的 RGB（0..1 浮点，相对色度意图）
static Napi::Value labToRgb(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object args = info[0].As<Napi::Object>();
    Napi::Uint8Array icc = args.Get("icc").As<Napi::Uint8Array>();
    Napi::Float64Array labIn = args.Get("lab").As<Napi::Float64Array>();
    cmsHPROFILE h = openMemProfile(env, icc, "labToRgb 打开配置");
    cmsHPROFILE lab = cmsCreateLab4Profile(nullptr);
    cmsHTRANSFORM x = cmsCreateTransform(lab, TYPE_Lab_DBL, h, TYPE_RGB_DBL,
        INTENT_RELATIVE_COLORIMETRIC, 0);
    if (!x) { cmsCloseProfile(h); cmsCloseProfile(lab); throwLcms(env, "labToRgb 变换"); }
    cmsUInt32Number n = labIn.ElementLength() / 3;
    Napi::Float32Array out = Napi::Float32Array::New(env, n * 3);
    for (cmsUInt32Number i = 0; i < n; i++) {
        cmsCIELab Lab = { labIn[i*3], labIn[i*3+1], labIn[i*3+2] };
        cmsFloat64Number rgb[3];
        cmsDoTransform(x, &Lab, rgb, 1);
        out[i*3] = (float)rgb[0]; out[i*3+1] = (float)rgb[1]; out[i*3+2] = (float)rgb[2];
    }
    cmsDeleteTransform(x); cmsCloseProfile(h); cmsCloseProfile(lab);
    return out;
}

// 判定一组 RGB（0..1）在某配置下是否超色域（相对色度，无 BPC）
static Napi::Value inGamut(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object args = info[0].As<Napi::Object>();
    Napi::Uint8Array srcIcc = args.Get("srcIcc").As<Napi::Uint8Array>();
    Napi::Uint8Array dstIcc = args.Get("dstIcc").As<Napi::Uint8Array>();
    Napi::Float32Array rgb = args.Get("rgb").As<Napi::Float32Array>();
    cmsHPROFILE hIn = openMemProfile(env, srcIcc, "inGamut 源");
    cmsHPROFILE hOut = openMemProfile(env, dstIcc, "inGamut 目标");
    cmsHTRANSFORM x = cmsCreateProofingTransform(hIn, TYPE_RGB_DBL, hOut, TYPE_RGB_DBL, hOut,
        INTENT_RELATIVE_COLORIMETRIC, INTENT_RELATIVE_COLORIMETRIC,
        cmsFLAGS_GAMUTCHECK);
    if (!x) { cmsCloseProfile(hIn); cmsCloseProfile(hOut); throwLcms(env, "inGamut 变换"); }
    cmsUInt32Number n = rgb.ElementLength() / 3;
    Napi::Uint8Array out = Napi::Uint8Array::New(env, n);
    // lcms2 浮点 GAMUTCHECK 对超色域像素固定输出 (-1,-1,-1)
    for (cmsUInt32Number i = 0; i < n; i++) {
        cmsFloat64Number in[3] = { rgb[i*3], rgb[i*3+1], rgb[i*3+2] }, r[3];
        cmsDoTransform(x, in, r, 1);
        out[i] = (r[0] < 0.0 && r[1] < 0.0 && r[2] < 0.0) ? 0 : 1;
    }
    cmsDeleteTransform(x); cmsCloseProfile(hIn); cmsCloseProfile(hOut);
    return out;
}

// 程序化生成测试/交付所需的标准配置，返回 ICC 字节
static Napi::Value createBuiltinProfile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string kind = info[0].As<Napi::String>().Utf8Value();
    cmsHPROFILE h = nullptr;

    if (kind == "srgb") {
        h = cmsCreate_sRGBProfile();
    } else if (kind == "linear-srgb") {
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = {
            {0.64, 0.33, 1.0}, {0.30, 0.60, 1.0}, {0.15, 0.06, 1.0} };
        cmsToneCurve* gamma[3] = { cmsBuildGamma(nullptr, 1.0), cmsBuildGamma(nullptr, 1.0), cmsBuildGamma(nullptr, 1.0) };
        h = cmsCreateRGBProfile(&white, &primaries, gamma);
        for (int i = 0; i < 3; i++) cmsFreeToneCurve(gamma[i]);
    } else if (kind == "display-p3") {
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = {
            {0.680, 0.320, 1.0}, {0.265, 0.690, 1.0}, {0.150, 0.060, 1.0} };
        cmsToneCurve* gamma[3] = { cmsBuildGamma(nullptr, 2.2), cmsBuildGamma(nullptr, 2.2), cmsBuildGamma(nullptr, 2.2) };
        h = cmsCreateRGBProfile(&white, &primaries, gamma);
        for (int i = 0; i < 3; i++) cmsFreeToneCurve(gamma[i]);
    } else if (kind == "adobergb") {
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = {
            {0.6400, 0.3300, 1.0}, {0.2100, 0.7100, 1.0}, {0.1500, 0.0600, 1.0} };
        cmsToneCurve* gamma[3];
        for (int i = 0; i < 3; i++) gamma[i] = cmsBuildGamma(nullptr, 2.19921875);
        h = cmsCreateRGBProfile(&white, &primaries, gamma);
        for (int i = 0; i < 3; i++) cmsFreeToneCurve(gamma[i]);
    } else if (kind == "narrow-gamut") {
        // 自制窄色域配置：sRGB 白点、更小的原色三角形、gamma 2.2，用于制造确定的超色域样本
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = {
            {0.50, 0.40, 1.0}, {0.30, 0.55, 1.0}, {0.20, 0.20, 1.0} };
        cmsToneCurve* gamma[3];
        for (int i = 0; i < 3; i++) gamma[i] = cmsBuildGamma(nullptr, 2.2);
        h = cmsCreateRGBProfile(&white, &primaries, gamma);
        for (int i = 0; i < 3; i++) cmsFreeToneCurve(gamma[i]);
    } else if (kind == "lab") {
        h = cmsCreateLab4Profile(nullptr);
    } else {
        throw Napi::Error::New(env, "未知内置配置: " + kind);
    }
    if (!h) throwLcms(env, ("createBuiltinProfile " + kind).c_str());

    cmsSetProfileVersion(h, 4.3);
    // 写入可识别的描述标签
    cmsMLU* mlu = cmsMLUalloc(nullptr, 1);
    const char* desc = kind.c_str();
    cmsMLUsetASCII(mlu, "en", "US", desc);
    cmsWriteTag(h, cmsSigProfileDescriptionTag, mlu);
    cmsMLUfree(mlu);
    cmsMLU* cpr = cmsMLUalloc(nullptr, 1);
    cmsMLUsetASCII(cpr, "en", "US", "Generated by museum color tool via LittleCMS2");
    cmsWriteTag(h, cmsSigCopyrightTag, cpr);
    cmsMLUfree(cpr);

    cmsUInt32Number needed = 0;
    if (!cmsSaveProfileToMem(h, nullptr, &needed) || needed == 0) {
        cmsCloseProfile(h); throwLcms(env, "cmsSaveProfileToMem 尺寸");
    }
    Napi::Uint8Array out = Napi::Uint8Array::New(env, needed);
    if (!cmsSaveProfileToMem(h, out.Data(), &needed)) {
        cmsCloseProfile(h); throwLcms(env, "cmsSaveProfileToMem 写出");
    }
    cmsCloseProfile(h);
    return out;
}

// 黑点（相对色度所需），返回目标配置下对应黑点的 RGB 0..1
static Napi::Value blackPoint(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Uint8Array icc = info[0].As<Napi::Uint8Array>();
    cmsHPROFILE h = openMemProfile(env, icc, "blackPoint");
    cmsCIEXYZ bp;
    if (!cmsDetectBlackPoint(&bp, h, INTENT_PERCEPTUAL, 0)) {
        cmsCloseProfile(h); throwLcms(env, "cmsDetectBlackPoint");
    }
    cmsCloseProfile(h);
    Napi::Object o = Napi::Object::New(env);
    o.Set("X", Napi::Number::New(env, bp.X));
    o.Set("Y", Napi::Number::New(env, bp.Y));
    o.Set("Z", Napi::Number::New(env, bp.Z));
    return o;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("profileInfo", Napi::Function::New(env, profileInfo));
    exports.Set("convertPixels", Napi::Function::New(env, convertPixels));
    exports.Set("rgbToLab", Napi::Function::New(env, rgbToLab));
    exports.Set("labToRgb", Napi::Function::New(env, labToRgb));
    exports.Set("inGamut", Napi::Function::New(env, inGamut));
    exports.Set("createBuiltinProfile", Napi::Function::New(env, createBuiltinProfile));
    exports.Set("blackPoint", Napi::Function::New(env, blackPoint));
    return exports;
}

NODE_API_MODULE(lcms_native, Init)
