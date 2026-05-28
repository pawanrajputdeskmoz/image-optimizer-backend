const {
  User,
  ImageOptimization,
  ImageJob,
  ImageJobItem,
  ImageStatus,
  ImageOldData,
  StoreImageStat,
} = require("../../models");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const fs = require("node:fs/promises");
const path = require("node:path");
const { get, postFormData, del } = require("../../utils/axiosUtils");
const { imageOptimizationQueue } = require("../../queue/imageOptimizationQueue");
const {
  normalizePagination,
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
  fetchProductTemplateContext,
  resolveGeneratedImageMeta,
  resolveImagePlacementFields,
  resolveOptimizeFormat,
  updateBigCommerceProductImageMetadata,
  createBulkOptimizationJob,
  writeOptimizationLogs,
  getOptimizationJobStatus,
  buildJobImageMeta,
  fetchAllCatalogImagesInChunks,  
} = require("./services");
const {
  optimizeImage,
  downloadImage,
  getImageSizesFromUrls,
  getImageSizeFromUrl,
  getImageSizeFromUrlWithRetry,
  resolveProductImageUrl,
  compressImage,
} = require("../../utils");
const { deleteFile } = require("../../utils/deleteFile");
const { performance } = require("perf_hooks");


//=======================================================
// Fetch all products
//=======================================================




exports.fetchAllProducts = async (req, reply) => {
  const apiStart = performance.now();

  try {
    /**
     * ------------------------------------------------
     * 1. Extract & Validate Input
     * ------------------------------------------------
     */

    const body = req.body || {};
    const storeHash = req.storeHash;


    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }


    const { page, limit } = normalizePagination(body);

    const query = req.query || {};
    const searchKeyword =
      typeof query.query === "string"
        ? query.query.trim()
        : ""

    const user = await User.findOne(
      { store_hash: storeHash },
      { access_token: 1, storeUrl: 1, _id: 0 }
    ).lean();

    if (!user) {
      return reply.status(404).send({
        success: false,
        message:
          "Store is not installed. User not found for this store_hash",
      });
    }

    const accessToken = req.accessToken || user.access_token;
    const storeUrl = user.storeUrl || null;

    if (
      typeof accessToken !== "string" ||
      accessToken.trim() === ""
    ) {
      return reply.status(401).send({
        success: false,
        message:
          "BigCommerce access token is missing for this store",
      });
    }

    /**
     * ------------------------------------------------
     * 4. Build Query Params
     * ------------------------------------------------
     */

    const params = new URLSearchParams({
      include: "images",
      include_fields:
        "id,name,page_title,price,images",
      page: String(page),
      limit: String(limit),   
    });

    if (searchKeyword) {
      params.set("keyword", searchKeyword);
    }

    const bcStart = performance.now();

    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${params.toString()}`,
      {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
        timeout: 10000,
      }
    );

    const bcEnd = performance.now();

    console.log(
      `[BigCommerce API] ${(
        bcEnd - bcStart
      ).toFixed(2)} ms`
    );


    const products = Array.isArray(response?.data)
      ? response.data
      : [];

    /**
     * ------------------------------------------------
     * 7. Extract Unique Image IDs
     * ------------------------------------------------
     *
     * Single-pass extraction
     * Lower memory pressure
     */

    const imageIdSet = new Set();

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      const images = product.images;

      if (!Array.isArray(images) || images.length === 0) {
        continue;
      }

      for (let j = 0; j < images.length; j++) {
        const imageId = images[j]?.id;

        if (imageId != null) {
          imageIdSet.add(imageId);
        }
      }
    }

    const imageIds =
      imageIdSet.size > 0
        ? Array.from(imageIdSet)
        : [];

    /**
     * ------------------------------------------------
     * 8. Fetch Image Statuses
     * ------------------------------------------------
     */

    const statusByImageId = Object.create(null);

    if (imageIds.length > 0) {
      const imageStatusRows = await ImageStatus.find(
        {
          store_hash: storeHash,
          image_id: { $in: imageIds },
        },
        {
          image_id: 1,
          status: 1,
          _id: 0,
        }
      ).lean();

      for (
        let i = 0;
        i < imageStatusRows.length;
        i++
      ) {
        const row = imageStatusRows[i];

        statusByImageId[row.image_id] =
          row.status;
      }
    }

    /**
     * ------------------------------------------------
     * 8b. Resolve image sizes via sharp (from live URLs)
     * ------------------------------------------------
     */

    const imageUrlItems = [];

    for (let i = 0; i < products.length; i++) {
      const images = products[i].images;
      if (!Array.isArray(images) || images.length === 0) continue;

      for (let j = 0; j < images.length; j++) {
        const image = images[j];
        const url = resolveProductImageUrl(
          storeUrl,
          image.image_file,
          image.url_zoom || null
        );

        if (image.id != null && url) {
          imageUrlItems.push({ imageId: image.id, url });
        }
      }
    }

    const sizeFetchStart = performance.now();
    const sizeByImageId =
      imageUrlItems.length > 0
        ? await getImageSizesFromUrls(imageUrlItems, {
          concurrency: Number(process.env.IMAGE_SIZE_FETCH_CONCURRENCY) || 8,
        })
        : Object.create(null);
    const sizeFetchEnd = performance.now();

    console.log(
      `[fetchAllProducts] Image size fetch: ${imageUrlItems.length} images in ${(
        sizeFetchEnd - sizeFetchStart
      ).toFixed(2)} ms`
    );

    /**
     * ------------------------------------------------
     * 9. Attach Optimization Status + Size
     * ------------------------------------------------
     */

    const optimizationStatusCounts =
      Object.create(null);

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      const images = product.images;

      if (!Array.isArray(images) || images.length === 0) {
        continue;
      }

      for (let j = 0; j < images.length; j++) {
        const image = images[j];

        const status =
          statusByImageId[image.id] || "pending";

        image.optimization_status = status;

        const sizeInfo = sizeByImageId[image.id];
        image.size = sizeInfo
          ? {
            bytes: sizeInfo.bytes,
            width: sizeInfo.width,
            height: sizeInfo.height,
            format: sizeInfo.format,
          }
          : {
            bytes: null,
            width: null,
            height: null,
            format: null,
          };


        optimizationStatusCounts[status] =
          (optimizationStatusCounts[status] || 0) + 1;

      }
    }

    /**
     * ------------------------------------------------
     * 10. Total API Timing
     * ------------------------------------------------
     */

    const apiEnd = performance.now();

    console.log(
      `[fetchAllProducts] Total API Time: ${(
        apiEnd - apiStart
      ).toFixed(2)} ms`
    );

    /**
     * ------------------------------------------------
     * 11. Send Response
     * ------------------------------------------------
     */

    return reply.status(200).send({
      success: true,
      message: "Products fetched successfully",

      data: products,

      pagination:
        response?.meta?.pagination || null,

      meta: {
        optimization_status_counts:
          optimizationStatusCounts,

        performance: {
          total_api_time_ms:
            Number(
              (apiEnd - apiStart).toFixed(2)
            ),

          bigcommerce_time_ms:
            Number(
              (bcEnd - bcStart).toFixed(2)
            ),
        },
      },
    });
  } catch (error) {
    console.error(
      "[fetchAllProducts ERROR]",
      error
    );

    const bcError =
      buildBigCommerceError(error);

    return reply
      .status(bcError.status)
      .send(bcError.body);
  }
};



//=======================================================
// Single Image Optimization With Manual Rollback
//=======================================================

exports.singleImageOptimization2 = async (req, reply) => {
  let filePath = null;
  let optimizedImagePath = null;
  let uploadedImage = null;
  let imageOptimization = null;

  try {
    //=======================================================
    // Request Data
    //=======================================================

    const body = req.body || {};

    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;

    const imageId = req.params.image_id;
    const productId = body.product_id;

    let imageUrl = resolveProductImageUrl(
      storeUrl,
      typeof body.image_url === "string"
        ? body.image_url.trim()
        : ""
    );

    //=======================================================
    // Validate Product ID
    //=======================================================

    if (!productId) {
      return reply.status(400).send({
        success: false,
        message: "product_id is required",
      });
    }

    //=======================================================
    // BigCommerce Access Token
    //=======================================================

    const accessToken = req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message:
          "BigCommerce access token is missing for this store",
      });
    }

    //=======================================================
    // Store Settings
    //=======================================================

    const {
      storeSettingsError,
      settings,
    } = await fetchStoreOptimizationSettings(storeHash);

    if (storeSettingsError) {
      return reply.status(400).send({
        success: false,
        message: storeSettingsError,
      });
    }



    //=======================================================
    // Existing Optimization Check
    //=======================================================

    const existingStatus = await ImageStatus.findOne({
      store_hash: storeHash,
      status: {
        $in: ["optimized", "pending", "optimizing"],
      },
      image_id: imageId,
    })
      .select({
        store_hash: 1,
        product_id: 1,
        image_id: 1,
        status: 1,
        optimized_at: 1,
        created_at: 1,
        updated_at: 1,
      })
      .lean();

    if (existingStatus?.status === "optimized") {
      const [base, oldData] = await Promise.all([
        ImageOptimization.findOne({
          store_hash: storeHash,
          image_id: imageId,
        })
          .select({
            store_hash: 1,
            product_id: 1,
            image_id: 1,
            bigcommerce_image_url: 1,
            original_image_path: 1,
            optimized_image_path: 1,
            bigcommerce_new_image_id: 1,
            bigcommerce_optimized_image_url: 1,
            optimization_type: 1,
            image_quality: 1,
            created_at: 1,
            updated_at: 1,
          })
          .lean(),

        ImageOldData.findOne({
          store_hash: storeHash,
          image_id: imageId,
        })
          .select({
            original: 1,
            optimized: 1,
            saved_bytes: 1,
            saved_percentage: 1,
          })
          .lean(),
      ]);

      return reply.status(200).send({
        success: true,
        message: "Image is already optimized",
        data: {
          ...(base || {}),
          ...(existingStatus || {}),
          ...(oldData || {}),
        },
      });
    }

    if (
      existingStatus?.status === "pending" ||
      existingStatus?.status === "optimizing"
    ) {
      const base = await ImageOptimization.findOne({
        store_hash: storeHash,
        image_id: imageId,
      })
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          bigcommerce_image_url: 1,
          optimization_type: 1,
          image_quality: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean();

      return reply.status(200).send({
        success: true,
        message:
          "Image is already in queue for optimization",
        data: {
          ...(base || {}),
          ...(existingStatus || {}),
        },
      });
    }

    //=======================================================
    // Fetch BigCommerce Image
    //=======================================================

    let bcImage = null;

    const bcHeaders = {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const needsBcImage = !imageUrl;

    const [bcImageResult] = await Promise.all([
      needsBcImage
        ? get(
          `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
          bcHeaders
        ).catch((bcErr) => {
          if (bcErr?.response?.status === 404) {
            return { notFound: true };
          }

          throw bcErr;
        })
        : Promise.resolve(null),
    ]);

    if (bcImageResult?.notFound) {
      return reply.status(404).send({
        success: false,
        message: "Image not found",
      });
    }

    if (bcImageResult?.data) {
      bcImage = bcImageResult.data;
    }

    if (!imageUrl && bcImage) {
      imageUrl = resolveProductImageUrl(
        storeUrl,
        bcImage?.image_file,
        bcImage?.url_standard || null
      );

      if (!imageUrl) {
        return reply.status(404).send({
          success: false,
          message: storeUrl
            ? "Image not found or image_file missing"
            : "Image not found. Reinstall app to save storeUrl.",
        });
      }
    }

    //=======================================================
    // Download Image
    //=======================================================

    const {
      error,
      filePath: downloadedFilePath,
      optimizedImagesDir,
      assetId,
    } = await downloadImage({
      imageUrl,
      storeHash,
      productId,
      imageId,
    });

    filePath = downloadedFilePath;


    if (error || !filePath) {
      await deleteFile(filePath).catch(() => { });

      return reply.status(400).send({
        success: false,
        message: error || "Failed to download image",
      });
    }

    //=======================================================
    // Create Optimization Record
    //=======================================================

    const imageQuality = Math.min(
      100,
      Math.max(1, Math.round(Number(settings.image_quality) || 80))
    );
    const optimizationType =
      imageQuality >= 75 ? "high" : imageQuality >= 45 ? "medium" : "low";

    imageOptimization =
      await ImageOptimization.findOneAndUpdate(
        {
          store_hash: storeHash,
          product_id: productId,
          image_id: imageId,
        },
        {
          $set: {
            bigcommerce_image_url: imageUrl,
            original_image_path: filePath,
            optimization_type: optimizationType,
            image_quality: imageQuality,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

    await Promise.all([
      ImageStatus.updateOne(
        {
          store_hash: storeHash,
          product_id: productId,
          image_id: imageId,
        },
        {
          $set: {
            status: "optimizing",
            optimization_started_at: new Date(),
          },
        },
        { upsert: true }
      ),

      ImageOldData.updateOne(
        {
          store_hash: storeHash,
          product_id: productId,
          image_id: imageId,
        },
        {
          $set: {
            original_image_path: filePath,
          },
        },
        { upsert: true }
      ),
    ]);

    //=======================================================
    // Optimize Image
    //=======================================================

    const {
      error: optimizeError,
      optimizedImage,
    } = await optimizeImage(
      filePath,
      {
        quality: settings.image_quality ?? 80,
        format: resolveOptimizeFormat(settings.output_format),
        outputPath: optimizedImagesDir,
        outputBaseName: assetId,
      }
    );

    if (optimizeError) {
      throw new Error(optimizeError);
    }

    optimizedImagePath =
      optimizedImage.outputPath;

    //=======================================================
    // Upload Optimized Image
    //=======================================================

    const fileBuf = await fs.readFile(
      optimizedImage.outputPath
    );

    const uploadFileName = path.basename(
      optimizedImage.outputPath
    );

    const mimeType =
      uploadFileName.endsWith(".png")
        ? "image/png"
        : uploadFileName.endsWith(".gif")
          ? "image/gif"
          : uploadFileName.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg";

    const form = new FormData();

    form.append(
      "image_file",
      new Blob([fileBuf], { type: mimeType }),
      uploadFileName
    );

    form.append("is_thumbnail", "false");
    form.append("sort_order", "1");

    form.append(
      "description",
      "Optimized image"
    );

    const bcUploadResponse = await postFormData(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images`,
      form,
      {
        "X-Auth-Token": accessToken,
      }
    );

    uploadedImage =
      bcUploadResponse?.data || null;

    if (!uploadedImage?.id) {
      throw new Error(
        "Failed to upload optimized image to BigCommerce"
      );
    }

    const newImageId = uploadedImage.id;

    const optimizedBcUrl =
      resolveProductImageUrl(
        storeUrl,
        uploadedImage.image_file,
        uploadedImage.url_standard || null
      );

    if (!optimizedBcUrl) {
      throw new Error(
        "BigCommerce upload succeeded but image URL could not be built"
      );
    }

    //=======================================================
    // Calculate Sizes
    //=======================================================

    const sizeFetchOptions = {
      retries:
        Number(
          process.env.BC_IMAGE_SIZE_FETCH_RETRIES
        ) || 4,

      retryDelayMs:
        Number(
          process.env.BC_IMAGE_SIZE_FETCH_DELAY_MS
        ) || 750,
    };

    const [
      originalFromBc,
      optimizedFromBc,
    ] = await Promise.all([
      getImageSizeFromUrl(
        imageUrl,
        sizeFetchOptions
      ),

      getImageSizeFromUrlWithRetry(
        optimizedBcUrl,
        sizeFetchOptions
      ),
    ]);

    if (optimizedFromBc.bytes == null) {
      throw new Error(
        optimizedFromBc.error ||
        "Failed to calculate optimized image size"
      );
    }

    const origSize =
      Number(originalFromBc.bytes) || 0;

    const optSize =
      Number(optimizedFromBc.bytes) || 0;

    const savedBytes =
      origSize > 0
        ? Math.max(0, origSize - optSize)
        : 0;

    const savedPercent =
      origSize > 0
        ? Number(
          (
            (savedBytes / origSize) *
            100
          ).toFixed(2)
        )
        : 0;

    const optimizedImageResponse = {
      outputPath: optimizedImage.outputPath,

      original: {
        ...(optimizedImage.original || {}),
        width: originalFromBc.width,
        height: originalFromBc.height,
        format: originalFromBc.format,
        size: originalFromBc.bytes,
      },

      optimized: {
        width: optimizedFromBc.width,
        height: optimizedFromBc.height,
        format: optimizedFromBc.format,
        size: optimizedFromBc.bytes,
      },

      compression: {
        savedBytes,
        savedPercent,
      },
    };

    //=======================================================
    // Delete Old BigCommerce Image
    //=======================================================

    try {
      await del(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
        {
          "X-Auth-Token": accessToken,
          Accept: "application/json",
        }
      );
    } catch (deleteErr) {
      console.error(
        "BigCommerce Delete Error:",
        deleteErr?.response?.data || deleteErr
      );
    }

    //=======================================================
    // Final Mongo Update
    //=======================================================

    await ImageOptimization.updateOne(
      {
        _id: imageOptimization._id,
      },
      {
        $set: {
          image_id: newImageId,

          optimized_image_path:
            optimizedImage.outputPath,

          bigcommerce_new_image_id: null,

          bigcommerce_optimized_image_url:
            optimizedBcUrl,

          image_quality:
            Number(optimizedImage.quality) || imageQuality,
        },
      }
    );

    await Promise.all([
      ImageOldData.updateOne(
        {
          store_hash: storeHash,
          product_id: productId,
          image_id: imageId,
        },
        {
          $set: {
            image_id: newImageId,

            original:
              optimizedImageResponse.original,

            optimized:
              optimizedImageResponse.optimized,

            saved_bytes: savedBytes,

            saved_percentage:
              savedPercent,
          },
        },
        { upsert: true }
      ),

      ImageStatus.updateOne(
        {
          store_hash: storeHash,
          product_id: productId,
          image_id: imageId,
        },
        {
          $set: {
            image_id: newImageId,
            status: "optimized",
            optimized_at: new Date(),
          },
        },
        { upsert: true }
      ),
    ]);

    //=======================================================
    // Update Store Stats
    //=======================================================

    try {
      const statDoc =
        await StoreImageStat.findOneAndUpdate(
          {
            store_hash: storeHash,
          },
          {
            $inc: {
              optimized_images: 1,

              total_original_size:
                origSize,

              total_optimized_size:
                optSize,

              total_saved_bytes:
                savedBytes,
            },

            $set: {
              last_optimized_at:
                new Date(),
            },

            $setOnInsert: {
              store_hash: storeHash,
            },
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          }
        );

      const totalOrig =
        Number(
          statDoc?.total_original_size
        ) || 0;

      const totalSaved =
        Number(
          statDoc?.total_saved_bytes
        ) || 0;

      if (totalOrig > 0) {
        await StoreImageStat.updateOne(
          {
            store_hash: storeHash,
          },
          {
            $set: {
              average_saving_percent:
                (totalSaved / totalOrig) *
                100,
            },
          }
        );
      }
    } catch (statErr) {
      console.error(
        "StoreImageStat success update error:",
        statErr
      );
    }

    //=======================================================
    // Final Response
    //=======================================================

    return reply.status(200).send({
      success: true,

      message:
        "Image optimized and replaced successfully",

      data: {
        old_image_id: imageId,

        new_image_id: newImageId,

        new_image_url: optimizedBcUrl,

        optimizedImage:
          optimizedImageResponse,

        status: "optimized",
      },
    });
  } catch (error) {
    //=======================================================
    // Mongo Rollback
    //=======================================================

    try {
      await ImageStatus.updateOne(
        {
          store_hash: req.storeHash,
          product_id: req.body?.product_id,
          image_id: req.params?.image_id,
        },
        {
          $set: {
            status: "failed",
          },
        },
        {
          upsert: true,
        }
      );

      if (req.storeHash) {
        await StoreImageStat.updateOne(
          {
            store_hash: req.storeHash,
          },
          {
            $inc: {
              failed_images: 1,
            },

            $setOnInsert: {
              store_hash: req.storeHash,
            },
          },
          {
            upsert: true,
          }
        );
      }
    } catch (mongoRollbackError) {
      console.error(
        "Mongo Rollback Error:",
        mongoRollbackError
      );
    }

    //=======================================================
    // Delete Original File
    //=======================================================

    try {
      if (filePath) {
        await deleteFile(filePath);
      }
    } catch (fileError) {
      console.error(
        "Original File Cleanup Error:",
        fileError
      );
    }

    //=======================================================
    // Delete Optimized File
    //=======================================================

    try {
      if (optimizedImagePath) {
        await deleteFile(
          optimizedImagePath
        );
      }
    } catch (optimizedFileError) {
      console.error(
        "Optimized File Cleanup Error:",
        optimizedFileError
      );
    }

    //=======================================================
    // Delete Uploaded BC Image
    //=======================================================

    try {
      if (uploadedImage?.id) {
        await del(
          `https://api.bigcommerce.com/stores/${req.storeHash}/v3/catalog/products/${req.body.product_id}/images/${uploadedImage.id}`,
          {
            "X-Auth-Token":
              req.currentUser?.access_token,

            Accept: "application/json",
          }
        );
      }
    } catch (cleanupErr) {
      console.error(
        "BigCommerce Cleanup Error:",
        cleanupErr
      );
    }

    console.error(
      "Single Image Optimization Error:",
      error
    );

    const bcError =
      buildBigCommerceError(error);

    return reply
      .status(bcError.status)
      .send(bcError.body);
  }
};


exports.getPreviewImgData = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    const imageId = Number(body.image_id);
    const productId = body.product_id != null ? Number(body.product_id) : null;

    if (!Number.isFinite(imageId)) {
      return reply.status(400).send({
        success: false,
        message: "image_id is required and must be a number",
      });
    }

    const optimizationQuery = { store_hash: storeHash, image_id: imageId };
    const oldDataQuery = { store_hash: storeHash, image_id: imageId };

    if (Number.isFinite(productId)) {
      optimizationQuery.product_id = productId;
      oldDataQuery.product_id = productId;
    }

    const [imageOptimization, imageOldData] = await Promise.all([
      ImageOptimization.findOne(optimizationQuery)
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          bigcommerce_image_url: 1,
          original_image_path: 1,
          optimized_image_path: 1,
          bigcommerce_new_image_id: 1,
          bigcommerce_optimized_image_url: 1,
          optimization_type: 1,
          image_quality: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),

      ImageOldData.findOne(oldDataQuery)
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          imageName: 1,
          altText: 1,
          original_image_path: 1,
          original: 1,
          optimized: 1,
          saved_bytes: 1,
          saved_percentage: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),
    ]);

    if (!imageOptimization && !imageOldData) {
      return reply.status(404).send({
        success: false,
        message: "Image preview data not found",
      });
    }

    const originalPath =
      imageOptimization?.original_image_path ||
      imageOldData?.original_image_path ||
      null;
    const optimizedPath = imageOptimization?.optimized_image_path || null;

    return reply.status(200).send({
      success: true,
      data: {
        image_id: imageId,
        product_id: imageOptimization?.product_id ?? imageOldData?.product_id ?? productId,
        optimization: imageOptimization || null,
        oldData: imageOldData || null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
      },
    });
  } catch (error) {
    console.error("Get Preview Image Data Error:", error);

    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch preview image data",
    });
  }
};





//=======================================================
// Single Image Optimization
//=======================================================

exports.singleImageOptimization = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const imageId = req.params.image_id;
    const productId = body.product_id;

    if (!productId) {
      return reply.status(400).send({ success: false, message: "product_id is required" });
    }

    const accessToken = req.currentUser?.access_token;
    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    const runOptimize = Boolean(settings.optimize_image_enabled);
    const runFilename = Boolean(settings.is_filename_template_enabled);
    const runAltText = Boolean(settings.is_alt_text_template_enabled);

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
        data: { settings },
      });
    }

    let imageUrl = resolveProductImageUrl(
      storeUrl,
      typeof body.image_url === "string" ? body.image_url.trim() : ""
    );
    let imageName = body.imageName || body.image_name || null;
    let altText = body.altText || body.alt_text || null;

    const bcHeaders = {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const needsBcImage = !imageUrl || runFilename || runAltText;
    const needsProductContext = runFilename || runAltText;

    const [bcImageResult, productContext] = await Promise.all([
      needsBcImage
        ? get(
            `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
            bcHeaders
          ).catch((bcErr) => {
            if (bcErr?.response?.status === 404) return { notFound: true };
            throw bcErr;
          })
        : Promise.resolve(null),
      needsProductContext
        ? fetchProductTemplateContext(storeHash, productId, accessToken, {
            currency: req.currentUser?.currency,
            store_name: req.currentUser?.store_name,
          })
        : Promise.resolve(null),
    ]);

    if (bcImageResult?.notFound && !imageUrl) {
      return reply.status(404).send({ success: false, message: "Image not found" });
    }

    const bcImage = bcImageResult?.data || null;

    if (!imageUrl && bcImage) {
      imageUrl = resolveProductImageUrl(
        storeUrl,
        bcImage?.image_file,
        bcImage?.url_standard || null
      );
      if (!imageUrl) {
        return reply.status(404).send({
          success: false,
          message: storeUrl
            ? "Image not found or image_file missing"
            : "Image not found. Reinstall app to save storeUrl.",
        });
      }
    }

    imageName = imageName || bcImage?.image_file || bcImage?.name || null;
    altText = altText || bcImage?.description || bcImage?.alt_text || null;

    const savedFromDb = await ImageOldData.findOne({
      store_hash: storeHash,
      product_id: productId,
      image_id: imageId,
    })
      .select({ imageName: 1, altText: 1, newImageName: 1, newAltText: 1 })
      .lean();

    const { oldImageName, oldAltText, newImageName, newAltText } =
      resolveGeneratedImageMeta({
        settings,
        productContext,
        sourceFileName: bcImage?.image_file || imageName || "image.jpg",
        fallbackImageName: imageName,
        fallbackAltText: altText,
        savedFromDb,
      });

    const placement = resolveImagePlacementFields({
      ...(bcImage || {}),
      ...body,
    });

    // Metadata-only (filename / alt templates, no compression)
    if (!runOptimize) {
      const metadataPayload = { ...placement };
      if (runFilename && newImageName) metadataPayload.imageFile = newImageName;
      if (runAltText && newAltText) metadataPayload.description = newAltText;

      await updateBigCommerceProductImageMetadata({
        storeHash,
        productId,
        imageId,
        accessToken,
        ...metadataPayload,
      });

      await Promise.all([
        ImageOldData.updateOne(
          { store_hash: storeHash, product_id: productId, image_id: imageId },
          {
            $set: {
              imageName: oldImageName,
              altText: oldAltText,
              ...(runFilename && newImageName ? { newImageName } : {}),
              ...(runAltText && newAltText ? { newAltText } : {}),
            },
          },
          { upsert: true }
        ),
        ImageStatus.updateOne(
          { store_hash: storeHash, product_id: productId, image_id: imageId },
          { $set: { status: "optimized", optimized_at: new Date() } },
          { upsert: true }
        ),
      ]);

      return reply.status(200).send({
        success: true,
        message: "Image metadata updated successfully",
        data: {
          image_id: imageId,
          product_id: productId,
          status: "optimized",
          settings,
          productContext,
          imageMeta: {
            oldImageName,
            oldAltText,
            newImageName: runFilename ? newImageName : null,
            newAltText: runAltText ? newAltText : null,
          },
        },
      });
    }

    const result = await compressImage({
      storeHash,
      storeUrl,
      accessToken,
      imageId,
      productId,
      imageUrl,
      settings,
      imageMeta: {
        oldImageName,
        oldAltText,
        newImageName,
        newAltText,
        runFilename,
        runAltText,
        ...placement,
      },
    });

    if (!result.success) {
      const bcError = buildBigCommerceError(new Error(result.error));
      return reply.status(bcError.status).send(bcError.body);
    }

    return reply.status(200).send({
      success: true,
      message: "Image optimized and replaced successfully",
      data: { ...result.data, },
    });
  } catch (error) {
    console.error("[singleImageOptimization] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

//=======================================================
// Bulk Image Optimization (BullMQ)
//=======================================================

async function queueBulkImageJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items =
      itemsOverride ??
      (Array.isArray(req.body) ? req.body : req.body?.images);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No images found in store catalog to queue for optimization"
          : "Request body must be a non-empty array of images",
      });
    }

    // const maxItems = Number(process.env.BULK_OPTIMIZE_MAX_ITEMS) || 100;
    // if (items.length > maxItems) {
    //   return reply.status(400).send({
    //     success: false,
    //     message: `Maximum ${maxItems} images per request`,
    //   });
    // }

    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const { error: settingError, settings } =
      await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
        data: { settings },
      });
    }

    const jobUuid = crypto.randomUUID();
    const skipped = [];
    const toQueue = [];
    const jobItems = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const productId = item.product_id;
      const imageId = item.image_id;
      const imageUrlRaw = item.image_url;

      const pushSkipped = (reason, extra = {}) => {
        skipped.push({
          index,
          reason,
          image_id: imageId ?? null,
          product_id: productId ?? null,
          ...extra,
        });
        if (productId != null && productId !== "" && imageId != null && imageId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            product_id: Number(productId),
            image_id: Number(imageId),
            image_url: imageUrlRaw ? String(imageUrlRaw).trim() : null,
            status: "skipped",
            skip_reason: reason,
          });
        }
      };

      if (shop && shop !== storeHash) {
        pushSkipped("shop does not match authenticated store");
        continue;
      }

      if (productId == null || productId === "") {
        pushSkipped("product_id is required");
        continue;
      }

      if (imageId == null || imageId === "") {
        pushSkipped("image_id is required");
        continue;
      }

      if (!imageUrlRaw || !String(imageUrlRaw).trim()) {
        pushSkipped("image_url is required");
        continue;
      }

      const imageUrl = String(imageUrlRaw).trim();
      const resolvedUrl = resolveProductImageUrl(storeUrl, imageUrl);
      if (!resolvedUrl) {
        pushSkipped("image_url could not be resolved");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        product_id: Number(productId),
        image_id: Number(imageId),
        image_url: imageUrl,
        status: "queued",
      });

      toQueue.push({
        index,
        productId,
        imageId: String(imageId),
        imageUrl,
      });
    }

    const { error: createJobError, doc: jobDoc } = await createBulkOptimizationJob({
      jobUuid,
      storeHash,
      jobType,
      totalImages: items.length,
      queuedImages: toQueue.length,
      skippedImages: skipped.length,
      jobItems,
    });

    if (createJobError || !jobDoc) {
      return reply.status(500).send({
        success: false,
        message: createJobError || "Failed to create optimization job in database",
      });
    }

    const productContextCache = new Map();
    const storeTemplateOptions = {
      currency: req.currentUser?.currency,
      store_name: req.currentUser?.store_name,
    };

    const toQueueWithMeta = await Promise.all(
      toQueue.map(async (entry) => {
        const imageMeta = await buildJobImageMeta({
          storeHash,
          productId: entry.productId,
          imageId: Number(entry.imageId),
          accessToken,
          settings,
          storeOptions: storeTemplateOptions,
          productContextCache,
        });
        return { ...entry, imageMeta };
      })
    );

    const queueResults = await Promise.all(
      toQueueWithMeta.map((entry) =>
        imageOptimizationQueue.add(
          "optimize-image",
          {
            jobUuid,
            job_type: jobType,
            storeHash,
            storeUrl,
            accessToken,
            productId: entry.productId,
            imageId: entry.imageId,
            imageUrl: entry.imageUrl,
            settings,
            imageMeta: entry.imageMeta,
          },
          {
            removeOnComplete: 200,
            removeOnFail: 500,
            attempts: 2,
            backoff: { type: "exponential", delay: 5000 },
          }
        )
      )
    );

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueueWithMeta[i].index,
      jobId: bullJob.id,
      image_id: toQueueWithMeta[i].imageId,
      product_id: toQueueWithMeta[i].productId,
    }));

    if (skipped.length > 0) {
      const { error: skipLogError } = await writeOptimizationLogs(
        skipped.map((skip) => ({
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: jobType,
          image_id: skip.image_id,
          product_id: skip.product_id,
          log_type: "warning",
          step: "skip",
          message: skip.reason,
          meta: { index: skip.index },
        }))
      );

      if (skipLogError) {
        console.error("[queueBulkImageJobs] skip logs:", skipLogError);
      }
    }

    const { error: statusError, job: jobRecord } = await getOptimizationJobStatus(
      jobUuid,
      storeHash
    );

    if (statusError) {
      console.error("[queueBulkImageJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "image-optimization",
      total_images: items.length,
      queued_images: jobs.length,
      skipped_images: skipped.length,
      settings: {
        optimize_image_enabled: Boolean(settings.optimize_image_enabled),
        is_filename_template_enabled: Boolean(
          settings.is_filename_template_enabled
        ),
        is_alt_text_template_enabled: Boolean(
          settings.is_alt_text_template_enabled
        ),
        image_quality: settings.image_quality,
        output_format: settings.output_format,
      },
      job: jobRecord,
      jobs,
      skipped,
    };

    if (req.catalogFetchMeta) {
      responseData.catalog = req.catalogFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: "Bulk image optimization jobs queued",
      data: responseData,
    });
  } catch (error) {
    console.error("[queueBulkImageJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk optimization",
    });
  }
}

/** Full-store: fetch all BC product images (chunked) → queue job_type `bulk` */
exports.bulkImageOptimization = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const { error: settingError, settings } =
      await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
        data: { settings },
      });
    }

    const { error: catalogError, items, meta } =
      await fetchAllCatalogImagesInChunks({
        storeHash,
        accessToken,
        storeUrl,
      });

    if (catalogError) {
      const bcError = buildBigCommerceError(new Error(catalogError));
      return reply.status(bcError.status).send(bcError.body);
    }

    req.catalogFetchMeta = meta;
    return queueBulkImageJobs(req, reply, "bulk", items);
  } catch (error) {
    console.error("[bulkImageOptimization] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Checkbox-selected images → job_type `checkBox` */
exports.bulkImageOptimizationCheckbox = (req, reply) =>
  queueBulkImageJobs(req, reply, "checkBox");

exports.getOptimizationJob = async (req, reply) => {
  try {
    const jobUuid = req.params.job_uuid;
    if (!jobUuid) {
      return reply.status(400).send({
        success: false,
        message: "job_uuid is required",
      });
    }

    const { error: statusError, job, logs, items } = await getOptimizationJobStatus(
      jobUuid,
      req.storeHash
    );

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job) {
      return reply.status(404).send({
        success: false,
        message: "Optimization job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: { job, logs, items },
    });
  } catch (error) {
    console.error("[getOptimizationJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch optimization job",
    });
  }
};

const RESTORE_BACKUP_DAYS = Number(process.env.RESTORE_BACKUP_DAYS) || 30;
const RESTORE_BACKUP_MS = RESTORE_BACKUP_DAYS * 24 * 60 * 60 * 1000;

exports.restoreImage = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token || null;
    const imageId = Number(req.params.image_id);
    const productId = Number(req.body.product_id);

    if (!Number.isFinite(imageId)) {
      return reply.status(400).send({
        success: false,
        message: "image_id must be a valid number",
      });
    }

    if (!Number.isFinite(productId)) {
      return reply.status(400).send({
        success: false,
        message: "product_id is required and must be a valid number",
      });
    }

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const lookup = {
      store_hash: storeHash,
      product_id: productId,
      image_id: imageId,
    };

    const [imageOptimization, imageStatus, imageOldData] = await Promise.all([
      ImageOptimization.findOne(lookup).lean(),
      ImageStatus.findOne(lookup).lean(),
      ImageOldData.findOne(lookup).lean(),
    ]);

    if (!imageOptimization && !imageStatus && !imageOldData) {
      return reply.status(404).send({
        success: false,
        message: "No optimized image record found for this product and image id",
      });
    }

    if (imageStatus?.status && imageStatus.status !== "optimized") {
      return reply.status(400).send({
        success: false,
        message: `Image cannot be restored because current status is "${imageStatus.status}", not "optimized"`,
      });
    }

    const optimizedAt =
      imageStatus?.optimized_at ||
      imageOptimization?.updated_at ||
      imageOldData?.updated_at ||
      null;

    if (!optimizedAt) {
      return reply.status(400).send({
        success: false,
        message: "Optimized date not found. This image may not have been optimized by the app",
      });
    }

    const ageMs = Date.now() - new Date(optimizedAt).getTime();
    if (ageMs > RESTORE_BACKUP_MS) {
      const optimizedOn = new Date(optimizedAt).toISOString().slice(0, 10);
      return reply.status(400).send({
        success: false,
        message: `Restore is not available. This image was optimized on ${optimizedOn}, which is more than ${RESTORE_BACKUP_DAYS} days ago. Backups are kept for ${RESTORE_BACKUP_DAYS} days only.`,
        data: {
          image_id: imageId,
          product_id: productId,
          optimized_at: optimizedAt,
          backup_retention_days: RESTORE_BACKUP_DAYS,
        },
      });
    }

    const originalPath =
      imageOptimization?.original_image_path ||
      imageOldData?.original_image_path ||
      null;

    if (!originalPath) {
      return reply.status(404).send({
        success: false,
        message:
          "Original image backup path not found in database. The file may have been removed already.",
      });
    }

    let originalStat;
    try {
      originalStat = await fs.stat(originalPath);
    } catch {
      return reply.status(404).send({
        success: false,
        message:
          "Original image backup file is missing on disk. Restore cannot continue.",
        data: { original_image_path: originalPath },
      });
    }

    if (!originalStat.isFile()) {
      return reply.status(400).send({
        success: false,
        message: "Original image backup path does not point to a valid file",
      });
    }

    const description =
      (req.body.altText && String(req.body.altText).trim()) ||
      (req.body.alt_text && String(req.body.alt_text).trim()) ||
      imageOldData?.altText ||
      imageOldData?.newAltText ||
      "Restored original image";

    const uploadFileName =
      (req.body.imageName && String(req.body.imageName).trim()) ||
      (req.body.image_name && String(req.body.image_name).trim()) ||
      imageOldData?.imageName ||
      path.basename(originalPath);

    const mimeType = uploadFileName.endsWith(".png")
      ? "image/png"
      : uploadFileName.endsWith(".gif")
        ? "image/gif"
        : uploadFileName.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";

    const placement = resolveImagePlacementFields(req.body || {});
    const fileBuf = await fs.readFile(originalPath);
    const form = new FormData();
    form.append(
      "image_file",
      new Blob([fileBuf], { type: mimeType }),
      uploadFileName
    );
    form.append(
      "is_thumbnail",
      String(placement.isThumbnail != null ? placement.isThumbnail : false)
    );
    form.append(
      "sort_order",
      String(placement.sortOrder != null ? placement.sortOrder : 1)
    );
    form.append("description", description);

    const bcUploadResponse = await postFormData(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images`,
      form,
      { "X-Auth-Token": accessToken }
    );

    const restoredImage = bcUploadResponse?.data || null;
    if (!restoredImage?.id) {
      return reply.status(502).send({
        success: false,
        message: "Failed to upload restored image to BigCommerce",
      });
    }

    const restoredImageId = restoredImage.id;
    const restoredBcUrl = resolveProductImageUrl(
      storeUrl,
      restoredImage.image_file,
      restoredImage.url_standard || null
    );

    try {
      await del(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
        { "X-Auth-Token": accessToken, Accept: "application/json" }
      );
    } catch (deleteErr) {
      console.error(
        "[restoreImage] BC delete optimized image:",
        deleteErr?.response?.data || deleteErr.message
      );
    }

    const optimizedPath = imageOptimization?.optimized_image_path || null;
    const origSize = Number(imageOldData?.original?.size) || Number(originalStat.size) || 0;
    const optSize = Number(imageOldData?.optimized?.size) || 0;
    const savedBytes =
      Number(imageOldData?.saved_bytes) ||
      (origSize > 0 ? Math.max(0, origSize - optSize) : 0);

    const cleanupTasks = [
      ImageOptimization.deleteOne(lookup),
      ImageOldData.deleteOne(lookup),
      ImageStatus.deleteOne(lookup),
      ImageJobItem.deleteMany({
        store_hash: storeHash,
        product_id: productId,
        image_id: imageId,
      }),
    ];

    if (origSize > 0 || optSize > 0 || savedBytes > 0) {
      cleanupTasks.push(
        StoreImageStat.updateOne(
          { store_hash: storeHash },
          {
            $inc: {
              optimized_images: -1,
              total_original_size: -origSize,
              total_optimized_size: -optSize,
              total_saved_bytes: -savedBytes,
            },
          }
        )
      );
    }

    await Promise.all(cleanupTasks);

    await Promise.all([
      deleteFile(originalPath).catch((err) => {
        console.error("[restoreImage] delete original file:", err.message);
      }),
      optimizedPath
        ? deleteFile(optimizedPath).catch((err) => {
            console.error("[restoreImage] delete optimized file:", err.message);
          })
        : Promise.resolve(),
    ]);

    return reply.status(200).send({
      success: true,
      message: "Image restored to original and optimization records removed",
      data: {
        restored_image_id: restoredImageId,
        removed_image_id: imageId,
        product_id: productId,
        restored_image_url: restoredBcUrl,
        backup_retention_days: RESTORE_BACKUP_DAYS,
      },
    });
  } catch (error) {
    console.error("[restoreImage] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.updateAltText = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken =
      req.currentUser?.access_token || req.accessToken || null;
    const imageId = req.params.image_id;
    const productId = req.body.product_id;
    const altText = req.body.alt_text;
    const placement = resolveImagePlacementFields(req.body || {});

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const result = await updateBigCommerceProductImageMetadata({
      storeHash,
      productId,
      imageId,
      accessToken,
      description: altText,
      ...placement,
    });

    if (result?.error) {
      return reply.status(400).send({
        success: false,
        message: result.error,
      });
    }

    if (result == null) {
      return reply.status(400).send({
        success: false,
        message:
          "At least one of alt_text, sort_order, or is_thumbnail is required",
      });
    }

    // await ImageOldData.updateOne(
    //   {
    //     store_hash: storeHash,
    //     product_id: Number(productId),
    //     image_id: Number(imageId),
    //   },
    //   {
    //     $set: {
    //       altText,
    //       newAltText: altText,
    //     },
    //   },
    //   { upsert: false }
    // ).catch(() => {});

    return reply.status(200).send({
      success: true,
      message: "Alt text updated",
      data: {
        image_id: Number(imageId),
        product_id: Number(productId),
        alt_text: altText,
        bigcommerce: result,
      },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);

    return reply.status(bcError.status).send(bcError.body);
  }
};