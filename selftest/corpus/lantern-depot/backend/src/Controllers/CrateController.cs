using Microsoft.AspNetCore.Mvc;

namespace LanternDepot.Api.Controllers
{
    [ApiController]
    [Route("depot/v2")]
    public class CrateController : ControllerBase
    {
        [HttpPost("crates/{id}/close")]
        public IActionResult CloseCrate(string id)
        {
            return Ok();
        }

        [HttpDelete("crates/{id}")]
        public IActionResult DeleteCrate(string id)
        {
            return Ok();
        }
    }
}
