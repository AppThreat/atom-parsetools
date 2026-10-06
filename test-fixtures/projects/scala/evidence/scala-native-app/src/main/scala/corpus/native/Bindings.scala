package corpus.native

import scala.scalanative.unsafe._

@link("crypto")
@extern
object libcrypto {
  def EVP_sha256(): Ptr[Byte] = extern // @expect crypto alg=SHA-256 kind=native-binding
  def EVP_md5(): Ptr[Byte] = extern // @expect crypto alg=MD5 kind=native-binding weak=true
  def EVP_aes_256_gcm(): Ptr[Byte] = extern // @expect crypto alg=AES-256-GCM kind=native-binding
  def EVP_Digest(data: Ptr[Byte], count: CSize, md: Ptr[Byte], size: Ptr[CUnsignedInt], tpe: Ptr[Byte], impl: Ptr[Byte]): CInt = extern
}

@link("curl")
@extern
object libcurl {
  def curl_easy_init(): Ptr[Byte] = extern
  def curl_easy_setopt(handle: Ptr[Byte], option: CInt, args: Any*): CInt = extern
  def curl_easy_perform(handle: Ptr[Byte]): CInt = extern
}
