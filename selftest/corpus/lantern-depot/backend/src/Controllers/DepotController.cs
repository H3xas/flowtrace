using Microsoft.AspNetCore.Mvc;

namespace LanternDepot.Api.Controllers
{
    [ApiController]
    [Route("depot/v1")]
    public class DepotController : ControllerBase
    {
        [HttpGet("shelves/count")]
        public IActionResult CountShelves()
        {
            return Ok();
        }

        [HttpPut("shelves/{id}")]
        public IActionResult RenameShelf(string id)
        {
            return Ok();
        }

        [HttpDelete("shelves/{id}")]
        public IActionResult RemoveShelf(string id)
        {
            return Ok();
        }

        [HttpPost("bins/{id}/open")]
        public IActionResult OpenBin(string id)
        {
            return Ok();
        }

        [HttpPost("bins/{id}/close")]
        public IActionResult CloseBin(string id)
        {
            return Ok();
        }

        [HttpPut("bins/{id}/label")]
        public IActionResult LabelBin(string id)
        {
            return Ok();
        }

        [HttpPost("audit/{id}")]
        public IActionResult StampAudit(string id)
        {
            return Ok();
        }
    }
}
