// archive_dump.cpp — 会话存档最小可用工具：GetChatData → RSA 解 key → DecryptData → 打印明文 JSON
//
// 仅用于测试企业验证 C2-0 A5/A6/A7。不要在生产环境直接使用。
//
// 依赖：
//   sudo apt install -y g++ libssl-dev
// 编译（在 C_sdk 目录，与 WeWorkFinanceSdk_C.h 同级）：
//   g++ -O2 -std=c++17 archive_dump.cpp -o archive_dump -ldl -lcrypto
// 用法：
//   ./archive_dump <seq> <limit> <私钥pem路径> [config.txt]
//   ./archive_dump 0 100 ./private_key.pem config.txt
//   ./archive_dump media --json <indexbuf> <sdkfileid> [config.txt]
//   ./archive_dump media --json "" SD KFILEID config.txt
// 说明：
//   config.txt 第 1 行 corpid，第 2 行 会话存档 Secret（与 tool_testSdk 一致）
//   私钥为后台「会话内容存档 → 消息加密公钥」配套的 RSA 私钥，PEM 格式（PKCS#1 / PKCS#8 均可）
//   media 子命令每次只取一片（≤512K），输出 {"data":"<base64>","isFinish":bool,"nextIndexbuf":"..."}；
//   indexbuf 传空串取第一片，之后传上一片返回的 nextIndexbuf。

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>

#include "WeWorkFinanceSdk_C.h"

static std::string trim(const std::string &s) {
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

static std::vector<unsigned char> base64_decode(const std::string &in) {
    std::string s;
    s.reserve(in.size());
    for (unsigned char c : in) {
        if (!isspace(c)) s.push_back((char)c);
    }
    std::vector<unsigned char> out(s.size());
    int n = EVP_DecodeBlock(out.data(), (const unsigned char *)s.data(), (int)s.size());
    if (n < 0) return {};
    size_t pad = 0;
    if (!s.empty() && s.back() == '=') pad++;
    if (s.size() > 1 && s[s.size() - 2] == '=') pad++;
    out.resize((size_t)n - pad);
    return out;
}

static const char *BASE64_CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64_encode(const unsigned char *buf, size_t len) {
    if (len == 0) return "";
    std::string out;
    out.reserve(4 * ((len + 2) / 3));
    size_t i = 0;
    for (; i + 2 < len; i += 3) {
        unsigned int v = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
        out.push_back(BASE64_CHARS[(v >> 18) & 0x3f]);
        out.push_back(BASE64_CHARS[(v >> 12) & 0x3f]);
        out.push_back(BASE64_CHARS[(v >> 6) & 0x3f]);
        out.push_back(BASE64_CHARS[v & 0x3f]);
    }
    if (i < len) {
        unsigned int v = buf[i] << 16;
        if (i + 1 < len) v |= buf[i + 1] << 8;
        out.push_back(BASE64_CHARS[(v >> 18) & 0x3f]);
        out.push_back(BASE64_CHARS[(v >> 12) & 0x3f]);
        out.push_back(i + 1 < len ? BASE64_CHARS[(v >> 6) & 0x3f] : '=');
        out.push_back('=');
    }
    return out;
}

static std::string rsa_decrypt(EVP_PKEY *pkey, const std::vector<unsigned char> &ct) {
    if (ct.empty()) return "";
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new(pkey, nullptr);
    if (!ctx) return "";
    std::string out;
    size_t outlen = 0;
    if (EVP_PKEY_decrypt_init(ctx) <= 0) {
        EVP_PKEY_CTX_free(ctx);
        return "";
    }
    EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_PADDING);
    if (EVP_PKEY_decrypt(ctx, nullptr, &outlen, ct.data(), ct.size()) <= 0) {
        EVP_PKEY_CTX_free(ctx);
        return "";
    }
    std::vector<unsigned char> buf(outlen);
    if (EVP_PKEY_decrypt(ctx, buf.data(), &outlen, ct.data(), ct.size()) <= 0) {
        EVP_PKEY_CTX_free(ctx);
        return "";
    }
    EVP_PKEY_CTX_free(ctx);
    out.assign((const char *)buf.data(), outlen);
    return out;
}

// chatdata 元素是扁平 JSON，值里不会出现转义引号，直接找 "key":"..." 即可
static std::string json_str(const std::string &obj, const std::string &key) {
    std::string pat = "\"" + key + "\":\"";
    size_t p = obj.find(pat);
    if (p == std::string::npos) return "";
    p += pat.size();
    size_t e = obj.find('"', p);
    if (e == std::string::npos) return "";
    return obj.substr(p, e - p);
}

static long long json_int(const std::string &obj, const std::string &key) {
    std::string pat = "\"" + key + "\":";
    size_t p = obj.find(pat);
    if (p == std::string::npos) return -1;
    return atoll(obj.c_str() + p + pat.size());
}

// 从 "chatdata":[ ... ] 里切出每个扁平对象
static std::vector<std::string> split_objects(const std::string &json) {
    std::vector<std::string> items;
    size_t arr = json.find("\"chatdata\"");
    if (arr == std::string::npos) return items;
    size_t i = json.find('[', arr);
    if (i == std::string::npos) return items;

    int depth = 0;
    size_t start = std::string::npos;
    for (; i < json.size(); ++i) {
        char c = json[i];
        if (c == '{') {
            if (depth == 0) start = i;
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 0 && start != std::string::npos) {
                items.push_back(json.substr(start, i - start + 1));
                start = std::string::npos;
            }
        } else if (c == ']' && depth == 0) {
            break;
        }
    }
    return items;
}

int main(int argc, char **argv) {
    // --json：只向 stdout 输出一行 JSON（供 Node 子进程解析）
    bool jsonMode = false;
    std::vector<std::string> pos;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--json") {
            jsonMode = true;
            continue;
        }
        pos.push_back(a);
    }

    if (pos.size() < 3) {
        fprintf(stderr,
                "用法: %s [--json] <seq> <limit> <私钥pem路径> [config.txt]\n"
                "      %s media --json <indexbuf> <sdkfileid> [config.txt]\n"
                "例:   %s 0 100 ./private_key.pem config.txt\n"
                "      %s --json 0 100 ./private_key.pem config.txt\n"
                "      %s media --json \"\" SD_FILEID config.txt\n",
                argv[0], argv[0], argv[0], argv[0], argv[0]);
        return 2;
    }

    unsigned long long seq = strtoull(pos[0].c_str(), nullptr, 10);
    unsigned int limit = (unsigned int)strtoul(pos[1].c_str(), nullptr, 10);
    std::string keyPath = pos[2];
    std::string cfgPath = (pos.size() >= 4) ? pos[3] : "config.txt";

    std::ifstream cfg(cfgPath);
    if (!cfg) {
        fprintf(stderr, "无法打开配置 %s\n", cfgPath.c_str());
        return 2;
    }
    std::string corpid, secret;
    std::getline(cfg, corpid);
    std::getline(cfg, secret);
    corpid = trim(corpid);
    secret = trim(secret);
    if (corpid.empty() || secret.empty()) {
        fprintf(stderr, "配置不完整：需要第 1 行 corpid、第 2 行 secret\n");
        return 2;
    }

    // media 子命令：media --json <indexbuf> <sdkfileid> [config.txt]
    // 每次只拉一片，由调用方（src/c2/media.ts）循环拼接到 isFinish。
    if (pos[0] == "media") {
        std::string indexbuf = pos[1];
        std::string sdkfileid = pos[2];

        WeWorkFinanceSdk_t *mediaSdk =
            static_cast<WeWorkFinanceSdk_t *>(NewSdk());
        if (!mediaSdk) {
            fprintf(stderr, "NewSdk 失败\n");
            return 3;
        }
        if (Init(mediaSdk, corpid.c_str(), secret.c_str()) != 0) {
            fprintf(stderr, "Init 失败\n");
            DestroySdk(mediaSdk);
            return 3;
        }

        MediaData_t *media = NewMediaData();
        if (!media) {
            fprintf(stderr, "NewMediaData 失败\n");
            DestroySdk(mediaSdk);
            return 3;
        }
        // 注意：官方头文件的参数顺序是 (sdk, indexbuf, sdkfileid, ...)
        int ret = GetMediaData(mediaSdk, indexbuf.c_str(), sdkfileid.c_str(), "",
                               "", 5, media);
        if (ret != 0) {
            fprintf(stderr, "GetMediaData 失败 ret=%d\n", ret);
            FreeMediaData(media);
            DestroySdk(mediaSdk);
            return 3;
        }

        int dataLen = GetDataLen(media);
        char *data = GetData(media);
        std::string encoded =
            base64_encode((const unsigned char *)data,
                          dataLen > 0 ? (size_t)dataLen : 0);
        char *next = GetOutIndexBuf(media);
        int finished = IsMediaDataFinish(media);
        printf("{\"data\":\"%s\",\"isFinish\":%s,\"nextIndexbuf\":\"%s\"}\n",
               encoded.c_str(), finished ? "true" : "false",
               next ? next : "");
        FreeMediaData(media);
        DestroySdk(mediaSdk);
        return 0;
    }

    FILE *kp = fopen(keyPath.c_str(), "r");
    if (!kp) {
        fprintf(stderr, "无法打开私钥 %s\n", keyPath.c_str());
        return 2;
    }
    EVP_PKEY *pkey = PEM_read_PrivateKey(kp, nullptr, nullptr, nullptr);
    fclose(kp);
    if (!pkey) {
        fprintf(stderr, "无法解析私钥（需要 PEM：PKCS#1 或 PKCS#8）\n");
        return 2;
    }

    // NewSdk() 在头文件里返回 void*，其余接口签名要 WeWorkFinanceSdk_t*
    WeWorkFinanceSdk_t *sdk = static_cast<WeWorkFinanceSdk_t *>(NewSdk());
    if (!sdk) {
        fprintf(stderr, "NewSdk 失败\n");
        EVP_PKEY_free(pkey);
        return 3;
    }
    int ret = Init(sdk, corpid.c_str(), secret.c_str());
    if (ret != 0) {
        fprintf(stderr, "Init 失败 ret=%d\n", ret);
        DestroySdk(sdk);
        EVP_PKEY_free(pkey);
        return 3;
    }

    Slice_t *chatdata = NewSlice();
    ret = GetChatData(sdk, seq, limit, "", "", 5, chatdata);
    if (ret != 0) {
        fprintf(stderr, "GetChatData 失败 ret=%d\n", ret);
        FreeSlice(chatdata);
        DestroySdk(sdk);
        EVP_PKEY_free(pkey);
        return 3;
    }

    std::string raw(GetContentFromSlice(chatdata), (size_t)GetSliceLen(chatdata));
    FreeSlice(chatdata);

    std::vector<std::string> items = split_objects(raw);
    if (!jsonMode) printf("拉取结果 len=%zu 条数=%zu\n", raw.size(), items.size());

    long long lastSeq = -1;
    std::vector<std::string> plains;
    for (size_t i = 0; i < items.size(); ++i) {
        const std::string &it = items[i];
        long long s = json_int(it, "seq");
        std::string msgid = json_str(it, "msgid");
        long long pvNum = json_int(it, "publickey_ver");
        std::string rk = json_str(it, "encrypt_random_key");
        std::string cm = json_str(it, "encrypt_chat_msg");
        if (s >= 0) lastSeq = s;

        if (!jsonMode) {
            printf("\n=== [%zu] seq=%lld msgid=%s publickey_ver=%lld ===\n", i + 1, s,
                   msgid.empty() ? "-" : msgid.c_str(), pvNum);
        }

        std::string key = rsa_decrypt(pkey, base64_decode(rk));
        if (key.empty()) {
            if (!jsonMode) {
                printf("RSA 解密失败：该条由旧版本公钥加密（publickey_ver 与当前私钥不匹配）\n");
            }
            continue;
        }

        Slice_t *msg = NewSlice();
        ret = DecryptData(key.c_str(), cm.c_str(), msg);
        if (ret != 0) {
            if (!jsonMode) printf("DecryptData 失败 ret=%d\n", ret);
            FreeSlice(msg);
            continue;
        }
        std::string plain(GetContentFromSlice(msg), (size_t)GetSliceLen(msg));
        FreeSlice(msg);

        if (jsonMode) {
            plains.push_back(plain);
        } else {
            printf("%s\n", plain.c_str());
        }
    }

    long long outSeq = (lastSeq >= 0) ? lastSeq : (long long)seq;
    if (jsonMode) {
        printf("{\"nextSeq\":%lld,\"count\":%zu,\"messages\":[", outSeq, plains.size());
        for (size_t i = 0; i < plains.size(); ++i) {
            if (i) printf(",");
            printf("%s", plains[i].c_str());
        }
        printf("]}\n");
    } else if (lastSeq >= 0) {
        printf("\n下次拉取用 seq=%lld（增量）\n", lastSeq);
    } else {
        printf("\n没有新消息。seq 有值时用 %llu 重试。\n", seq);
    }

    DestroySdk(sdk);
    EVP_PKEY_free(pkey);
    return 0;
}
