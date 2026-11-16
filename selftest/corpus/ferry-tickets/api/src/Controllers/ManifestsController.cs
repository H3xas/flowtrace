using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[Route(ApiRoutes.Manifests.Path)] /* every manifest call */
public class ManifestsController : ControllerBase
{
    private readonly ManifestStore _store;

    public ManifestsController(ManifestStore store)
    {
        _store = store;
    }

    [Route("files")]
    [HttpPost]
    [DisableRequestSizeLimit] /* streamed to storage */
    [Consumes("multipart/form-data")]
    public IActionResult UploadFile(FileRequest request)
    {
        return Ok(_store.Save(request));
    }

    [HttpPut(ApiRoutes.Manifests.Stamp)]
    public IActionResult Stamp(StampRequest request)
    {
        return Ok(_store.Stamp(request));
    }
}
